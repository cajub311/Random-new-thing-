// OpenClaw's "brain": system prompt + tool-calling loop with reflection.
//
// Design notes
// ────────────
// • The system prompt is explicit about planning, tool-use, memory, and when
//   to stop. Empirically this makes a huge difference for smaller local
//   models (7B/8B) that otherwise either loop forever or never call tools.
// • We inject a compressed "memory brief" (top-N relevant notes) into the
//   system prompt every turn so the model doesn't have to call `recall`
//   unless it wants more.
// • The loop supports an explicit `final_answer` tool (see skills/final-
//   answer.skill.js). If the model uses it, we exit immediately and return
//   the answer text — this is much more reliable than waiting for an
//   assistant message without tool_calls on small models.
// • If the model emits both text content and tool_calls in the same turn,
//   we still execute the tools but buffer the text so the user sees the
//   reasoning when it lands.

export const SYSTEM_PROMPT = ({ memoryBrief, toolNames, currentTime }) => `
You are OpenClaw, an open-source personal AI assistant. You are helpful,
concise, and honest. You run on the user's own machine whenever possible.

Core behavior
─────────────
• Think step-by-step. For any task that needs more than one tool call, start
  by calling \`plan\` with a short numbered list of concrete steps, then
  execute those steps.
• Prefer TOOLS over guessing for anything factual, time-sensitive, or
  computational. Never fabricate URLs, prices, phone numbers, or statistics —
  use web_search + fetch_url instead.
• When the user states preferences or durable facts about themselves
  ("my name is …", "I live in …", "I'm working on …"), call \`remember\` so
  you can recall them later. When a question depends on prior context, call
  \`recall\` before answering.
• Use \`calculate\` for any non-trivial arithmetic — do not do math in your
  head. Use \`current_time\` for "now"/"today".
• When a user asks for a file, draft, or document, produce it via the
  \`create_file\` tool so they can download it.
• When producing an email draft, always use the \`draft_email\` tool.
• When the user asks for an image, use \`generate_image\`.
• Stop when you are truly done. You MUST call the \`final_answer\` tool to
  deliver your reply to the user — a plain assistant message alone is NOT
  shown. \`final_answer\` takes one argument, \`answer\`, which must be the
  complete markdown you want the user to see. Call it exactly once, at the
  end, and do not call any other tool after it.

Tool-use rules
──────────────
• Only call tools that exist in the provided list: ${toolNames.join(', ')}.
• Pass arguments as JSON matching each tool's schema exactly.
• After a tool returns, READ its result before deciding what to do next.
• Never call the same tool with the same arguments twice in a row.
• Keep each chain of tool calls short (ideally ≤ 4 steps).

Style
─────
• Write plainly. Use GitHub-flavored markdown. Code blocks must include a
  language tag.
• Cite sources inline as [title](url) whenever you used web_search/fetch_url.
• Never invent citations. If the web search had no useful result, say so.

Environment
───────────
• Current UTC time: ${currentTime}
${memoryBrief ? '\nMemory brief (things you have previously learned):\n' + memoryBrief : ''}
`.trim();

export async function buildMemoryBrief(memory, userMessages, limit = 6) {
  // Concatenate recent user messages as a query; recall the top few notes.
  const query = userMessages.slice(-3).map(m => m.content).join(' ');
  const matches = await memory.search({ query, limit });
  if (!matches.length) {
    // Also surface the highest-importance notes as a fallback.
    const all = await memory.all();
    const pinned = all
      .filter(e => (e.importance || 1) >= 3)
      .slice(0, 5)
      .map(e => `- ${e.text}`);
    return pinned.join('\n');
  }
  return matches.map(m => `- ${m.text}${m.tags?.length ? ` [${m.tags.join(', ')}]` : ''}`).join('\n');
}

// Rough token estimate (chars/4 heuristic — close enough for budgeting).
function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

function estimateConvoTokens(convo) {
  let total = 0;
  for (const m of convo) {
    if (typeof m.content === 'string') total += estimateTokens(m.content);
    else if (Array.isArray(m.content)) {
      for (const p of m.content) if (p?.type === 'text') total += estimateTokens(p.text);
    }
    if (m.tool_calls) for (const tc of m.tool_calls) total += estimateTokens(tc.function?.arguments || '');
  }
  return total;
}

// Drop oldest non-system, non-latest turns until we fit under a soft cap.
// Preserves the system message and the tail of the conversation, so tool
// call/result pairs stay coherent.
function trimConvoToBudget(convo, budget = 8000) {
  if (estimateConvoTokens(convo) <= budget) return { convo, trimmed: 0 };
  const system = convo.filter(m => m.role === 'system');
  const rest = convo.filter(m => m.role !== 'system');
  // Always keep the last 6 messages to maintain recent tool-call coherence.
  const keepTail = rest.slice(-6);
  const older = rest.slice(0, -6);
  let kept = older;
  while (kept.length && estimateConvoTokens([...system, ...kept, ...keepTail]) > budget) {
    kept.shift();
  }
  const trimmed = older.length - kept.length;
  return { convo: [...system, ...kept, ...keepTail], trimmed };
}

function toolCallSignature(tc) {
  return `${tc.function?.name}|${tc.function?.arguments || ''}`;
}

/**
 * Run the agent tool-calling loop.
 * @param {object} cfg
 *  - provider         : provider config object
 *  - callOpenAI       : function(provider, messages, model, key, {tools}) => message
 *  - messages         : initial conversation (incl. system prompt)
 *  - model, apiKey
 *  - skills           : { name: { run(args, ctx) } }
 *  - toolDefs         : OpenAI-format tool schemas
 *  - maxSteps, ctx, onStep
 *  - fallbackProviders (optional): [{ provider, model, apiKey }] tried in
 *     order when the primary provider throws. Lets the agent survive one
 *     provider being down or over quota without crashing the whole request.
 *  - contextBudget    : soft token cap before trimming oldest turns
 *  - toolResultCap    : byte cap per tool result before we signal truncation
 */
export async function runAgent({
  provider, callOpenAI, messages, model, apiKey,
  skills, toolDefs, maxSteps = 8, ctx, onStep,
  fallbackProviders = [], contextBudget = 8000, toolResultCap = 16000,
}) {
  const trace = [];
  let convo = [...messages];
  const TRUNC_MARKER = '\n\n[truncated: tool result exceeded size cap. Call with narrower args for more detail.]';
  // Loop-detection: if the same (tool, args) signature fires 2x in a row,
  // nudge the model to stop or change strategy.
  const recentCalls = [];

  const tryCall = async (messagesForCall, { tools = toolDefs } = {}) => {
    const attempts = [{ provider, model, apiKey }, ...fallbackProviders];
    let lastErr = null;
    for (const { provider: p, model: m, apiKey: k } of attempts) {
      try { return await callOpenAI(p, messagesForCall, m, k, { tools }); }
      catch (e) { lastErr = e; ctx?.logger?.warn?.('agent provider failed', { provider: p?.name, err: e.message }); }
    }
    throw lastErr || new Error('all providers failed');
  };

  for (let step = 0; step < maxSteps; step++) {
    const trimmed = trimConvoToBudget(convo, contextBudget);
    if (trimmed.trimmed > 0) {
      ctx?.logger?.info?.('agent trimmed context', { dropped: trimmed.trimmed });
      convo = trimmed.convo;
    }

    const msg = await tryCall(convo);
    const toolCalls = msg.tool_calls || [];
    const assistantEntry = { role: 'assistant', content: msg.content || '' };
    if (toolCalls.length) assistantEntry.tool_calls = toolCalls;
    convo.push(assistantEntry);

    if (!toolCalls.length) {
      if (msg.content && msg.content.trim()) {
        return { reply: msg.content, steps: step + 1, trace, convo };
      }
      // Model went silent (only emitted reasoning) — nudge it once.
      convo.push({
        role: 'system',
        content: 'You did not produce a user-facing answer. Call `final_answer` now with your complete markdown reply.',
      });
      continue;
    }

    // Loop detection: same (tool, args) three times across the trailing
    // tool-call window → force a stop.
    const sigs = toolCalls.map(toolCallSignature);
    for (const sig of sigs) recentCalls.push(sig);
    const tail = recentCalls.slice(-3);
    if (tail.length === 3 && tail.every(s => s === tail[0])) {
      convo.push({
        role: 'system',
        content: 'You called the same tool with the same arguments three times. That is a loop. Call `final_answer` now with the best answer you can give from the information so far.',
      });
    }

    for (const tc of toolCalls) {
      const fname = tc.function?.name;
      const fargs = tc.function?.arguments || '{}';
      let args;
      try { args = fargs ? JSON.parse(fargs) : {}; }
      catch (e) { args = { __parse_error: String(e.message) }; }

      // If the model calls final_answer, we exit with its answer as the reply.
      if (fname === 'final_answer') {
        const answer = String(args?.answer || '');
        trace.push({ step: step + 1, tool: fname, args, result: { answer } });
        onStep?.({ step: step + 1, tool: fname, args, result: { answer } });
        return { reply: answer, steps: step + 1, trace, convo };
      }

      const skill = skills[fname];
      let result;
      if (!skill) {
        const available = Object.keys(skills).join(', ');
        result = { error: `unknown tool: ${fname}. Available tools: ${available}` };
      } else if (args?.__parse_error) {
        result = {
          error: `invalid JSON arguments for ${fname}: ${args.__parse_error}. Received: ${String(fargs).slice(0, 200)}. Fix the JSON and retry.`,
        };
      } else {
        try { result = await skill.run(args, ctx); }
        catch (e) { result = { error: String(e.message || e) }; }
      }

      trace.push({ step: step + 1, tool: fname, args, result });
      onStep?.({ step: step + 1, tool: fname, args, result });
      let serialized = JSON.stringify(result);
      if (serialized.length > toolResultCap) {
        serialized = serialized.slice(0, toolResultCap - TRUNC_MARKER.length) + TRUNC_MARKER;
      }
      convo.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: fname,
        content: serialized,
      });
    }
  }

  // Max steps reached — ask the model for a short wrap-up without tools.
  convo.push({
    role: 'system',
    content: 'You have reached the tool-call step limit. Reply with your best final answer now, in markdown, without calling any more tools.',
  });
  const finalMsg = await tryCall(convo, { tools: [] });
  return {
    reply: finalMsg.content || 'Reached the max tool-call step limit.',
    steps: maxSteps,
    trace,
    convo,
    truncated: true,
  };
}
