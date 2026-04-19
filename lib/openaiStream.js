// Parse OpenAI-compatible SSE streams (chat completions with stream: true).
// Merges delta.tool_calls across chunks and surfaces assistant text deltas.

function mergeToolCallDelta(toolCalls, deltaTc) {
  if (!deltaTc || !Array.isArray(deltaTc)) return;
  for (const d of deltaTc) {
    const idx = d.index ?? 0;
    if (!toolCalls[idx]) {
      toolCalls[idx] = { id: d.id || '', type: d.type || 'function', function: { name: '', arguments: '' } };
    }
    if (d.id) toolCalls[idx].id = d.id;
    if (d.function?.name) toolCalls[idx].function.name += d.function.name;
    if (d.function?.arguments != null && d.function.arguments !== '') {
      toolCalls[idx].function.arguments += d.function.arguments;
    }
  }
}

/**
 * Stream a chat completion; invokes onDelta({ content }) for assistant-visible text
 * as it arrives (delta.content plus incremental decode of final_answer.answer).
 * Returns the merged assistant message { role, content, tool_calls? }.
 */
export async function consumeOpenAIChatStream({
  url,
  headers,
  body,
  signal,
  onDelta = () => {},
}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => '');
    throw new Error(`stream ${res.status}: ${t}`);
  }

  let fullContent = '';
  const mergedToolCalls = [];
  let answerEmitPos = 0; // chars of decoded "answer" already sent via onDelta

  const tryEmitAnswerFromArgs = (argStr) => {
    const r = extractAnswerStreamingSuffix(argStr, answerEmitPos);
    if (r.suffix) {
      onDelta({ content: r.suffix });
      answerEmitPos = r.newPos;
    }
  };

  const decoder = new TextDecoder();
  let buf = '';
  const reader = res.body.getReader();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 2);
      if (!raw) continue;
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let obj;
        try { obj = JSON.parse(payload); } catch { continue; }
        const choice = obj.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;
        if (!delta) continue;
        if (delta.content) {
          fullContent += delta.content;
          onDelta({ content: delta.content });
        }
        if (delta.tool_calls?.length) {
          mergeToolCallDelta(mergedToolCalls, delta.tool_calls);
          for (const tc of mergedToolCalls) {
            const name = tc?.function?.name || '';
            const args = tc?.function?.arguments || '';
            if (name === 'final_answer' && args) tryEmitAnswerFromArgs(args);
          }
        }
      }
    }
  }

  const tool_calls = mergedToolCalls
    .filter(tc => tc?.function?.name || tc?.function?.arguments)
    .map(tc => ({
      id: tc.id || `call_${Math.random().toString(36).slice(2)}`,
      type: 'function',
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments || '{}',
      },
    }));

  const msg = { role: 'assistant', content: fullContent };
  if (tool_calls.length) msg.tool_calls = tool_calls;
  return msg;
}

/**
 * From partial JSON for final_answer tool arguments, emit new decoded characters
 * of the "answer" string value after lastEmitted (byte index into decoded answer).
 */
export function extractAnswerStreamingSuffix(argStr, lastEmitted) {
  // Locate "answer" key and opening quote of string value
  const keyMatch = argStr.match(/"answer"\s*:\s*"/);
  if (!keyMatch) return { suffix: '', newPos: lastEmitted };
  const start = keyMatch.index + keyMatch[0].length;
  let i = start;
  let out = '';
  while (i < argStr.length) {
    const c = argStr[i];
    if (c === '\\') {
      if (i + 1 >= argStr.length) break; // wait for more
      const n = argStr[i + 1];
      if (n === 'n') { out += '\n'; i += 2; continue; }
      if (n === 'r') { out += '\r'; i += 2; continue; }
      if (n === 't') { out += '\t'; i += 2; continue; }
      if (n === '"' || n === '\\') { out += n; i += 2; continue; }
      out += n;
      i += 2;
      continue;
    }
    if (c === '"') {
      // end of string — emit remainder and fix position to full length
      const suffix = out.slice(lastEmitted);
      return { suffix, newPos: out.length };
    }
    out += c;
    i++;
  }
  const suffix = out.slice(lastEmitted);
  return { suffix, newPos: out.length };
}
