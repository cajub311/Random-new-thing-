/* ── OpenClaw frontend app ──────────────────────────────────────────── */

const API = '';  // same-origin; set full URL if backend is separate

// ── State ─────────────────────────────────────────────────────────────────
let providers   = {};
let messages    = [];            // {role, content}[] — conversation history
let isLoading   = false;
let chatMode    = 'auto';        // 'auto' | 'agent' | 'ask-all'
let pendingFileText = null;
let currentController = null;    // AbortController for in-flight requests
let sessions    = [];            // [{id, title, mode, messages, updated}]
let currentSessionId = null;

// Local LLMs first, then keyless cloud, then key-based cloud.
const PROVIDER_ORDER = ['ollama', 'lmstudio', 'llamacpp', 'pollinations', 'groq', 'gemini', 'together', 'cohere', 'huggingface'];

// ── DOM refs ───────────────────────────────────────────────────────────────
const providerSelect = document.getElementById('providerSelect');
const modelSelect    = document.getElementById('modelSelect');
const apiKeyInput    = document.getElementById('apiKeyInput');
const toggleKeyBtn   = document.getElementById('toggleKeyBtn');
const getKeyLink     = document.getElementById('getKeyLink');
const systemPrompt   = document.getElementById('systemPrompt');
const tempRange      = document.getElementById('tempRange');
const tempVal        = document.getElementById('tempVal');
const statusDot      = document.getElementById('statusDot');
const statusText     = document.getElementById('statusText');
const messagesEl     = document.getElementById('messages');
const chatForm       = document.getElementById('chatForm');
const userInput      = document.getElementById('userInput');
const sendBtn        = document.getElementById('sendBtn');
const sendIcon       = document.getElementById('sendIcon');
const loadingIcon    = document.getElementById('loadingIcon');
const stopBtn        = document.getElementById('stopBtn');
const clearBtn       = document.getElementById('clearBtn');
const newChatBtn     = document.getElementById('newChatBtn');
const sidebarToggle  = document.getElementById('sidebarToggle');
const sidebar        = document.getElementById('sidebar');
const providerCards  = document.getElementById('providerCards');
const attachBtn      = document.getElementById('attachBtn');
const fileInput      = document.getElementById('fileInput');
const modeToggle     = document.getElementById('modeToggle');
const modeHint       = document.getElementById('modeHint');
const activePill     = document.getElementById('activePill');
const filesList      = document.getElementById('filesList');
const refreshFilesBtn= document.getElementById('refreshFilesBtn');
const keySection     = document.getElementById('keySection');
const sessionsList   = document.getElementById('sessionsList');
const exportChatBtn  = document.getElementById('exportChatBtn');
const slashMenu      = document.getElementById('slashMenu');
const memoryList     = document.getElementById('memoryList');
const refreshMemoryBtn = document.getElementById('refreshMemoryBtn');
const clearMemoryBtn = document.getElementById('clearMemoryBtn');

// ── Markdown setup (marked + DOMPurify + highlight.js) ─────────────────────
if (window.marked) {
  marked.setOptions({
    gfm: true,
    breaks: true,
    highlight(code, lang) {
      try {
        if (lang && window.hljs?.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
        return window.hljs ? hljs.highlightAuto(code).value : code;
      } catch { return code; }
    },
  });
}

function renderMarkdown(text) {
  if (!window.marked) return escapeHtml(text).replace(/\n/g, '<br>');
  const html = marked.parse(String(text ?? ''));
  return window.DOMPurify ? DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'download'] }) : html;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

function safeJsonStringify(obj, space) {
  try { return JSON.stringify(obj, null, space); } catch { return String(obj); }
}

/** One-line params for the live "Thinking: running tool(…)" banner (exact JSON when small). */
function formatToolParamsShort(args, rawArguments) {
  if (!args || typeof args !== 'object') {
    const raw = rawArguments != null ? String(rawArguments) : '';
    return raw.length > 220 ? `${raw.slice(0, 220)}…` : raw;
  }
  if (args.__parse_error) {
    const raw = rawArguments != null ? String(rawArguments) : '';
    return raw.length > 220 ? `${raw.slice(0, 220)}…` : raw;
  }
  let s;
  try { s = JSON.stringify(args); } catch { s = String(args); }
  if (s.length > 240) return `${s.slice(0, 240)}…`;
  return s;
}

function typingDotsHtml() {
  return '<div class="typing-bubble"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></div>';
}

/** Parse text/event-stream from a ReadableStreamDefaultReader. */
async function readEventStream(reader, decoder, onEvent) {
  let buf = '';
  const dispatchBlock = async block => {
    const trimmed = block.trim();
    if (!trimmed) return;
    let event = 'message';
    let data = '';
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) return;
    try {
      const payload = JSON.parse(data);
      await onEvent(event, payload);
    } catch { /* ignore malformed */ }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      await dispatchBlock(block);
    }
  }
  if (buf.trim()) await dispatchBlock(buf);
}

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  loadSettings();
  loadSessions();
  try {
    const res = await fetch(`${API}/api/providers`);
    providers = await res.json();
    buildProviderUI();
    restoreProvider();
    updateStatus();
  } catch (e) {
    setStatus('error', 'Cannot reach server');
  }
  renderSessions();
}

function buildProviderUI() {
  providerSelect.innerHTML = '';
  providerCards.innerHTML = '';
  for (const [id, p] of Object.entries(providers)) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = p.name + (p.configured ? ' ✓' : '');
    providerSelect.appendChild(opt);

    const card = document.createElement('div');
    card.className = 'provider-card' + (p.configured ? ' configured' : '') + (p.local ? ' local' : '');
    const tag = p.local
      ? (p.configured ? '🖥️ Local • Connected' : '🖥️ Local • Not running')
      : (p.configured ? '✓ Connected' : 'FREE tier');
    card.innerHTML = `
      <div class="card-name">${escapeHtml(p.name)}</div>
      <div class="card-tag">${tag}</div>
      ${p.description ? `<div class="card-desc">${escapeHtml(p.description)}</div>` : ''}`;
    card.addEventListener('click', () => {
      providerSelect.value = id;
      providerSelect.dispatchEvent(new Event('change'));
      sidebar.classList.remove('collapsed');
      sidebar.classList.add('open');
    });
    providerCards.appendChild(card);
  }
}

function restoreProvider() {
  const saved = localStorage.getItem('cc_provider');
  const firstAvailable = getAvailableProviders()[0]?.id;
  const target = (saved && providers[saved]) ? saved : (firstAvailable || Object.keys(providers)[0]);
  if (target) providerSelect.value = target;
  providerSelect.dispatchEvent(new Event('change'));
}

// ── Provider change ────────────────────────────────────────────────────────
providerSelect.addEventListener('change', () => {
  const id = providerSelect.value;
  const p = providers[id];
  if (!p) return;

  modelSelect.innerHTML = '';
  for (const m of p.models) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    if (m === p.defaultModel) opt.selected = true;
    modelSelect.appendChild(opt);
  }

  if (p.keyless) {
    keySection.style.display = 'none';
    apiKeyInput.value = '';
  } else {
    keySection.style.display = '';
    const savedKey = localStorage.getItem(`cc_key_${id}`) || '';
    apiKeyInput.value = savedKey;
    getKeyLink.href = p.signupUrl;
    getKeyLink.textContent = `Get free ${p.name} key →`;
  }

  updateStatus();
  localStorage.setItem('cc_provider', id);
});

apiKeyInput.addEventListener('input', () => {
  const id = providerSelect.value;
  const trimmed = apiKeyInput.value.trim();
  if (trimmed) localStorage.setItem(`cc_key_${id}`, trimmed);
  else         localStorage.removeItem(`cc_key_${id}`);
  updateStatus();
});

// ── Mode toggle ────────────────────────────────────────────────────────────
const MODE_HINTS = {
  'auto':    'Chat mode — streams, tries providers in order, auto-fallback',
  'agent':   'Agent mode — AI uses tools: web, files, images, email, math',
  'ask-all': 'Sends to all configured providers simultaneously',
};
modeToggle.addEventListener('click', e => {
  const btn = e.target.closest('.mode-btn');
  if (!btn) return;
  setChatMode(btn.dataset.mode);
});
function setChatMode(mode) {
  chatMode = mode;
  modeToggle.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  modeHint.textContent = MODE_HINTS[mode] || '';
  updateStatus();
  localStorage.setItem('cc_mode', mode);
  if (mode === 'agent') loadFiles();
}

// ── Available providers helper ─────────────────────────────────────────────
function getAvailableProviders({ toolsOnly = false } = {}) {
  const preferred = providerSelect.value;
  const ordered = [preferred, ...PROVIDER_ORDER.filter(id => id !== preferred)];
  return ordered
    .filter(id => providers[id])
    .filter(id => !toolsOnly || providers[id].supportsTools)
    .map(id => {
      const p = providers[id];
      if (p.keyless) return { id, key: '' };
      const key = localStorage.getItem(`cc_key_${id}`) || '';
      if (key || p.configured) return { id, key };
      return null;
    })
    .filter(Boolean);
}

// ── Status helpers ─────────────────────────────────────────────────────────
function updateStatus() {
  const needsTools = chatMode === 'agent';
  const available = getAvailableProviders({ toolsOnly: needsTools });
  if (available.length === 0) {
    setStatus('offline', needsTools ? 'Agent mode needs a tool-capable provider' : 'No keys configured');
    activePill.textContent = '';
    activePill.className = 'provider-pill';
    return;
  }
  if (chatMode === 'ask-all') {
    setStatus('online', `${available.length} provider${available.length > 1 ? 's' : ''} ready`);
    activePill.textContent = `Ask All (${available.length})`;
    activePill.className = 'provider-pill online';
  } else {
    const first = available[0];
    const name = providers[first.id].name;
    const prefix = chatMode === 'agent' ? '🤖 ' : '';
    const extra = available.length > 1 && chatMode !== 'agent'
      ? ` +${available.length - 1} fallback${available.length > 2 ? 's' : ''}`
      : '';
    setStatus('online', `${prefix}${name}${extra}`);
    activePill.textContent = prefix + name;
    activePill.className = 'provider-pill online';
  }
}

function setStatus(state, text) {
  statusDot.className = `status-dot ${state}`;
  statusText.textContent = text;
}

// ── Chat mode: streaming first, fallback to JSON on failure ───────────────
async function sendAuto(msgs) {
  const available = getAvailableProviders();
  if (available.length === 0) {
    appendMessage('assistant', 'No providers available. Make sure Pollinations is selected or add a key.', true);
    return;
  }

  for (let i = 0; i < available.length; i++) {
    const { id, key } = available[i];
    const name = providers[id].name;
    if (i > 0) setStatus('warning', `Trying ${name}…`);

    const ok = await streamChat(id, key, msgs, name);
    if (ok) return;
    // streamChat returns false on failure; try next provider
  }

  appendMessage('assistant', 'All providers failed. Please check your API keys or connection.', true);
  setStatus('error', 'All providers failed');
}

async function streamChat(id, key, msgs, name) {
  const bubble = appendAssistantShell(id);
  const bodyEl = bubble.querySelector('.msg-bubble');
  bodyEl.classList.add('streaming');
  bodyEl.innerHTML = '<div class="typing-bubble"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></div>';
  currentController = new AbortController();
  setLoading(true, true);

  let buffer = '';
  let hadAny = false;
  let streamRaf = null;
  const flushStreamBubble = () => {
    streamRaf = null;
    if (buffer) {
      if (!hadAny) {
        bodyEl.innerHTML = '';
        hadAny = true;
      }
      bodyEl.innerHTML = renderMarkdown(buffer) + '<span class="cursor">▋</span>';
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  };
  const scheduleStreamBubble = () => {
    if (streamRaf == null) streamRaf = requestAnimationFrame(flushStreamBubble);
  };

  try {
    const res = await fetch(`${API}/api/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: id,
        model: providerSelect.value === id ? modelSelect.value : providers[id].defaultModel,
        apiKey: key || undefined,
        messages: [
          { role: 'system', content: systemPrompt.value || 'You are a helpful assistant.' },
          ...msgs,
        ],
      }),
      signal: currentController.signal,
    });

    if (!res.ok || !res.body) {
      let errMsg = `HTTP ${res.status}`;
      try { const d = await res.json(); errMsg = d.error || errMsg; } catch {}
      bubble.remove();
      return false;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const lines = chunk.split('\n');
        let event = 'message';
        let data = '';
        for (const l of lines) {
          if (l.startsWith('event:')) event = l.slice(6).trim();
          else if (l.startsWith('data:')) data += l.slice(5).trim();
        }
        if (!data) continue;
        try {
          const obj = JSON.parse(data);
          if (event === 'delta' && obj.content) {
            buffer += obj.content;
            scheduleStreamBubble();
          } else if (event === 'done') {
            if (streamRaf != null) cancelAnimationFrame(streamRaf);
            streamRaf = null;
            // final render without cursor
            bodyEl.innerHTML = renderMarkdown(buffer);
            enhanceCodeBlocks(bodyEl);
            bodyEl.classList.remove('streaming');
            wireMessageActions(bubble, buffer);
            messages.push({ role: 'assistant', content: buffer });
            setStatus('online', `${name} responded`);
            activePill.textContent = name;
            activePill.className = 'provider-pill online';
            saveCurrentSession();
            return true;
          } else if (event === 'error') {
            throw new Error(obj.message || 'stream error');
          }
        } catch (e) { /* swallow malformed chunk */ }
      }
    }

    // stream ended without "done" event
    if (buffer) {
      if (streamRaf != null) cancelAnimationFrame(streamRaf);
      streamRaf = null;
      bodyEl.innerHTML = renderMarkdown(buffer);
      enhanceCodeBlocks(bodyEl);
      bodyEl.classList.remove('streaming');
      wireMessageActions(bubble, buffer);
      messages.push({ role: 'assistant', content: buffer });
      saveCurrentSession();
      return true;
    }
    bubble.remove();
    return false;
  } catch (err) {
    if (streamRaf != null) cancelAnimationFrame(streamRaf);
    streamRaf = null;
    if (err.name === 'AbortError') {
      bodyEl.innerHTML = renderMarkdown(buffer || '_(stopped)_');
      enhanceCodeBlocks(bodyEl);
      bodyEl.classList.remove('streaming');
      wireMessageActions(bubble, buffer);
      if (buffer) messages.push({ role: 'assistant', content: buffer });
      setStatus('online', 'Stopped');
      return true;
    }
    console.error(err);
    bubble.remove();
    return false;
  } finally {
    currentController = null;
    setLoading(false);
  }
}

// ── Agent mode (SSE: thinking line, tool artifacts, streamed final reply) ─
function appendAgentShell(providerId) {
  removeWelcome();
  const div = document.createElement('div');
  div.className = 'message assistant agent-live';
  const name = providers[providerId]?.name || 'AI';
  div.innerHTML = `
    <div class="msg-meta">
      <span class="msg-avatar">🤖</span>
      <strong>${escapeHtml(name)}</strong>
      <span class="agent-badge">agent</span>
      <span>${timestamp()}</span>
    </div>
    <div class="agent-live-panel">
      <div class="agent-thinking-row">
        <div class="agent-thinking-banner" aria-live="polite"></div>
        <div class="agent-typing-inline">${typingDotsHtml()}</div>
      </div>
      <div class="agent-tools"></div>
      <div class="msg-bubble agent-reply streaming" style="display:none"></div>
    </div>
    <div class="msg-actions">
      <button class="msg-action-btn copy-btn" disabled>Copy</button>
      <button class="msg-action-btn retry-btn">Retry</button>
    </div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

/** Same rich summaries as trace items, wrapped for inline agent artifacts. */
function renderAgentArtifactBody(item) {
  const { tool, args, result, step } = item;
  const argStr = safeJsonStringify(args, 2);
  let summary = '';
  if (tool === 'web_search' && result?.results?.length) {
    summary = `<ul class="artifact-results">${result.results.map(r =>
      `<li><a href="${escapeAttr(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a><div class="artifact-snippet">${escapeHtml(r.snippet || '')}</div></li>`
    ).join('')}</ul>`;
  } else if (tool === 'fetch_url') {
    summary = `<div class="artifact-snippet">Fetched ${escapeHtml(result?.url || '')} (${result?.length || 0} chars)</div>`;
  } else if (tool === 'create_file' && result?.download_url) {
    summary = `<div class="artifact-file">📄 <a href="${escapeAttr(result.download_url)}" download>${escapeHtml(result.filename)}</a> (${result.bytes} bytes)</div>`;
  } else if (tool === 'draft_email' && result?.mailto_link) {
    summary = `<div class="artifact-file">✉️ <a href="${escapeAttr(result.mailto_link)}">Open draft to ${escapeHtml(result.to)}</a></div>`;
  } else if (tool === 'generate_image' && result?.image_url) {
    summary = `<div class="artifact-image"><img src="${escapeAttr(result.image_url)}" alt="${escapeAttr(result.prompt || '')}" loading="lazy" /><div class="artifact-snippet">${escapeHtml(result.prompt || '')}</div></div>`;
  } else if (tool === 'calculate' && typeof result?.result === 'number') {
    summary = `<div class="artifact-snippet">Result: <strong>${escapeHtml(String(result.result))}</strong></div>`;
  } else if (tool === 'remember' && result?.id) {
    summary = `<div class="artifact-snippet">💾 Saved to memory: <em>${escapeHtml(result.text)}</em></div>`;
  } else if (tool === 'recall' && result?.matches) {
    summary = result.matches.length
      ? `<ul class="artifact-results">${result.matches.map(m => `<li><em>${escapeHtml(m.text)}</em></li>`).join('')}</ul>`
      : `<div class="artifact-snippet">No relevant memories found.</div>`;
  } else if (tool === 'final_answer') {
    summary = '';
  } else if (tool === 'read_file' && result?.filename) {
    summary = `<div class="artifact-snippet">📖 Read ${escapeHtml(result.filename)} (${result.length} chars)</div>`;
  } else if (tool === 'current_time' && result?.iso) {
    summary = `<div class="artifact-snippet">${escapeHtml(result.utc || result.iso)}</div>`;
  } else if (result?.error) {
    summary = `<div class="artifact-error">Error: ${escapeHtml(result.error)}</div>`;
  } else {
    const raw = safeJsonStringify(result, 2);
    summary = `<pre class="artifact-json">${escapeHtml(raw.length > 4000 ? `${raw.slice(0, 4000)}\n…` : raw)}</pre>`;
  }
  return `
    <header class="artifact-head">Step ${step}: <code>${escapeHtml(tool)}</code></header>
    <pre class="artifact-args">${escapeHtml(argStr)}</pre>
    ${summary}`;
}

function mountAgentArtifact(toolsHost, item) {
  const article = document.createElement('article');
  article.className = 'agent-artifact artifact-enter';
  article.innerHTML = renderAgentArtifactBody(item);
  toolsHost.appendChild(article);
  requestAnimationFrame(() => {
    article.classList.add('artifact-enter-active');
  });
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/**
 * Reveal the final markdown in small steps for a token-like feel (full text is known).
 * Returns a cancel function.
 */
/** @returns {Promise<{ text: string, aborted: boolean }>} */
function streamReplyText(element, fullText, { signal } = {}) {
  const full = String(fullText ?? '');
  let i = 0;
  let raf = null;
  let cancelled = false;
  const charsPerFrame = full.length ? Math.max(2, Math.ceil(full.length / 400)) : 0;

  return new Promise(resolve => {
    const finish = () => {
      element.classList.remove('streaming');
      element.innerHTML = renderMarkdown(full);
      enhanceCodeBlocks(element);
      resolve({ text: full, aborted: false });
    };

    const tick = () => {
      if (cancelled) return;
      if (signal?.aborted) {
        cancelled = true;
        element.classList.remove('streaming');
        const partial = full.slice(0, i);
        element.innerHTML = renderMarkdown(partial);
        enhanceCodeBlocks(element);
        resolve({ text: partial, aborted: true });
        return;
      }
      if (!full.length) {
        cancelled = true;
        finish();
        return;
      }
      i = Math.min(full.length, i + charsPerFrame);
      const slice = full.slice(0, i);
      element.innerHTML = renderMarkdown(slice) + (i < full.length ? '<span class="cursor">▋</span>' : '');
      messagesEl.scrollTop = messagesEl.scrollHeight;
      if (i < full.length) raf = requestAnimationFrame(tick);
      else {
        cancelled = true;
        finish();
      }
    };

    element.style.display = '';
    element.classList.add('streaming');
    raf = requestAnimationFrame(tick);
  });
}

async function sendAgent(msgs) {
  const available = getAvailableProviders({ toolsOnly: true });
  if (available.length === 0) {
    appendMessage('assistant', 'Agent mode needs a tool-capable provider (Pollinations, Groq, or Together).', true);
    return;
  }
  const { id, key } = available[0];
  const name = providers[id].name;
  const bubble = appendAgentShell(id);
  const thinkingBanner = bubble.querySelector('.agent-thinking-banner');
  const typingInline = bubble.querySelector('.agent-typing-inline');
  const toolsHost = bubble.querySelector('.agent-tools');
  const replyEl = bubble.querySelector('.agent-reply');
  const thinkingRow = bubble.querySelector('.agent-thinking-row');

  currentController = new AbortController();
  const signal = currentController.signal;
  setLoading(true, true);

  const setThinkingToolLine = (tool, args, rawArguments) => {
    const params = formatToolParamsShort(args, rawArguments);
    const tail = params ? ` ${params}` : '';
    thinkingBanner.textContent = `Thinking: running ${tool}${tail}`;
    typingInline.style.display = '';
  };

  const setThinkingLlmLine = (step, wrapUp) => {
    thinkingBanner.textContent = wrapUp
      ? 'Thinking (finishing up)…'
      : `Thinking (step ${step})…`;
    typingInline.style.display = '';
  };

  try {
    const res = await fetch(`${API}/api/agent/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: id,
        model: providerSelect.value === id ? modelSelect.value : providers[id].defaultModel,
        apiKey: key || undefined,
        messages: [
          { role: 'system', content: systemPrompt.value || 'You are a helpful assistant with tools.' },
          ...msgs,
        ],
        maxSteps: 6,
      }),
      signal,
    });

    if (!res.ok || !res.body) {
      let errMsg = `HTTP ${res.status}`;
      try {
        const d = await res.json();
        errMsg = d.error || errMsg;
      } catch { /* use errMsg */ }
      bubble.remove();
      appendMessage('assistant', `Agent error: ${errMsg}`, true, id);
      setStatus('error', 'Agent failed');
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let donePayload = null;

    await readEventStream(reader, decoder, async (event, data) => {
      if (event === 'agent_started') {
        thinkingBanner.textContent = 'Connecting…';
      } else if (event === 'thinking_llm') {
        setThinkingLlmLine(data.step, data.wrapUp);
      } else if (event === 'thinking_tool') {
        setThinkingToolLine(data.tool, data.args, data.rawArguments);
      } else if (event === 'tool_result') {
        if (data.tool && data.tool !== 'final_answer') {
          mountAgentArtifact(toolsHost, data);
        }
        thinkingBanner.textContent = '';
      } else if (event === 'done') {
        donePayload = data;
      } else if (event === 'error') {
        throw new Error(data.message || 'Agent stream error');
      }
    });

    if (!donePayload) {
      bubble.remove();
      appendMessage('assistant', 'Agent stream ended unexpectedly.', true, id);
      setStatus('error', 'Agent failed');
      return;
    }

    const reply = donePayload.reply || '';
    const steps = donePayload.steps | 0;
    if (thinkingRow) thinkingRow.style.display = 'none';

    const { text: shownReply, aborted: replyAborted } = await streamReplyText(replyEl, reply, { signal });

    bubble.querySelector('.copy-btn')?.removeAttribute('disabled');
    wireMessageActions(bubble, shownReply);
    messages.push({ role: 'assistant', content: shownReply });
    setStatus('online', replyAborted ? 'Stopped' : `${name} answered (${steps} step${steps === 1 ? '' : 's'})`);
    activePill.textContent = `🤖 ${name}`;
    activePill.className = 'provider-pill online';
    saveCurrentSession();
    loadFiles();
  } catch (err) {
    if (err.name === 'AbortError') {
      setStatus('online', 'Stopped');
      if (bubble.parentNode) bubble.remove();
    } else {
      if (bubble.parentNode) bubble.remove();
      appendMessage('assistant', `Agent error: ${err.message}`, true);
      setStatus('error', 'Agent failed');
    }
  } finally {
    currentController = null;
    setLoading(false);
  }
}

// ── Ask All mode: fan out, show each response with badge ──────────────────
async function sendAskAll(msgs) {
  const available = getAvailableProviders();
  if (available.length === 0) {
    appendMessage('assistant', 'No API keys configured. Add at least one free key in the sidebar.', true);
    return;
  }

  const slots = available.map(({ id }) => ({ id, typingId: appendTyping(providers[id].name) }));
  setLoading(true);

  await Promise.allSettled(available.map(async ({ id, key }, i) => {
    try {
      const res = await fetch(`${API}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: id,
          model: providers[id].defaultModel,
          apiKey: key || undefined,
          messages: [
            { role: 'system', content: systemPrompt.value || 'You are a helpful assistant.' },
            ...msgs,
          ],
        }),
      });
      const data = await res.json();
      removeTyping(slots[i].typingId);
      if (!res.ok || data.error) {
        appendMessage('assistant', `[${providers[id].name}] ${data.error || res.statusText}`, true, id, true);
      } else {
        appendMessage('assistant', data.reply, false, id, true);
      }
    } catch (err) {
      removeTyping(slots[i].typingId);
      appendMessage('assistant', `[${providers[id].name}] ${err.message}`, true, id, true);
    }
  }));

  setLoading(false);
  setStatus('online', `${available.length} providers answered`);
}

// ── Submit handler ─────────────────────────────────────────────────────────
chatForm.addEventListener('submit', async e => {
  e.preventDefault();
  if (isLoading) return;
  let text = userInput.value.trim();
  if (!text && !pendingFileText) return;

  // Slash commands
  if (text.startsWith('/')) {
    const handled = handleSlashCommand(text);
    if (handled) { userInput.value = ''; userInput.style.height = 'auto'; return; }
  }

  if (pendingFileText) {
    text = text ? `${text}\n\n\`\`\`\n${pendingFileText}\n\`\`\`` : `\`\`\`\n${pendingFileText}\n\`\`\``;
    pendingFileText = null;
    userInput.placeholder = 'Ask anything… (Shift+Enter for new line, type / for commands)';
  }

  userInput.value = '';
  userInput.style.height = 'auto';
  removeWelcome();
  appendMessage('user', text);
  messages.push({ role: 'user', content: text });
  saveCurrentSession();

  if (chatMode === 'ask-all')     await sendAskAll([...messages]);
  else if (chatMode === 'agent')  await sendAgent([...messages]);
  else                            await sendAuto([...messages]);
});

// ── Slash commands ─────────────────────────────────────────────────────────
const SLASH_COMMANDS = [
  { cmd: '/clear',  desc: 'Clear the current conversation' },
  { cmd: '/new',    desc: 'Start a new conversation' },
  { cmd: '/export', desc: 'Download this conversation as markdown' },
  { cmd: '/chat',   desc: 'Switch to chat mode' },
  { cmd: '/agent',  desc: 'Switch to agent mode (tools)' },
  { cmd: '/askall', desc: 'Switch to ask-all mode' },
  { cmd: '/image ', desc: 'Agent: generate an image from a prompt' },
  { cmd: '/search ',desc: 'Agent: web search + summary' },
  { cmd: '/file ',  desc: 'Agent: create a text file' },
  { cmd: '/help',   desc: 'Show this list' },
];

function handleSlashCommand(text) {
  const [raw, ...rest] = text.split(/\s+/);
  const cmd = raw.toLowerCase();
  const arg = rest.join(' ').trim();
  switch (cmd) {
    case '/clear':  messages = []; showWelcome(); saveCurrentSession(); return true;
    case '/new':    newSession(); return true;
    case '/export': exportChat(); return true;
    case '/chat':   setChatMode('auto'); return true;
    case '/agent':  setChatMode('agent'); return true;
    case '/askall': setChatMode('ask-all'); return true;
    case '/help': {
      removeWelcome();
      appendMessage('assistant', '**Slash commands**\n\n' + SLASH_COMMANDS.map(s => `- \`${s.cmd.trim()}\` — ${s.desc}`).join('\n'));
      return true;
    }
    case '/image': {
      setChatMode('agent');
      userInput.value = `Generate an image: ${arg || 'a cute cat in a forest'}`;
      return false;
    }
    case '/search': {
      setChatMode('agent');
      userInput.value = `Search the web for: ${arg}. Summarize the key findings.`;
      return false;
    }
    case '/file': {
      setChatMode('agent');
      userInput.value = `Create a file. ${arg}`;
      return false;
    }
    default: return false;
  }
}

userInput.addEventListener('input', () => {
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 200) + 'px';
  const v = userInput.value;
  if (v.startsWith('/') && !v.includes('\n') && !v.includes(' ')) {
    const matches = SLASH_COMMANDS.filter(s => s.cmd.startsWith(v.toLowerCase()));
    if (matches.length) {
      slashMenu.hidden = false;
      slashMenu.innerHTML = matches.map(m =>
        `<div class="slash-item" data-cmd="${m.cmd}"><code>${m.cmd}</code><span>${escapeHtml(m.desc)}</span></div>`
      ).join('');
      return;
    }
  }
  slashMenu.hidden = true;
});

slashMenu.addEventListener('click', e => {
  const item = e.target.closest('.slash-item');
  if (!item) return;
  userInput.value = item.dataset.cmd;
  slashMenu.hidden = true;
  userInput.focus();
  if (!item.dataset.cmd.endsWith(' ')) {
    chatForm.dispatchEvent(new Event('submit'));
  }
});

// ── UI controls ────────────────────────────────────────────────────────────
toggleKeyBtn.addEventListener('click', () => {
  apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
});

tempRange.addEventListener('input', () => tempVal.textContent = tempRange.value);

clearBtn.addEventListener('click', () => { messages = []; showWelcome(); saveCurrentSession(); });
newChatBtn.addEventListener('click', () => newSession());

sidebarToggle.addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
  sidebar.classList.toggle('open');
});

document.getElementById('sidebarClose')?.addEventListener('click', () => {
  sidebar.classList.remove('open');
  sidebar.classList.add('collapsed');
});

// ── Voice input (Web Speech API) ──────────────────────────────────────────
(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = document.getElementById('micBtn');
  if (!SR || !micBtn) return;
  micBtn.hidden = false;

  const rec = new SR();
  rec.continuous = false;
  rec.interimResults = true;
  rec.lang = navigator.language || 'en-US';

  let listening = false;
  let baseText = '';

  rec.addEventListener('result', (e) => {
    let interim = '';
    let final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += t;
      else interim += t;
    }
    userInput.value = (baseText + ' ' + final + interim).trim();
    userInput.dispatchEvent(new Event('input', { bubbles: true }));
  });
  rec.addEventListener('end', () => {
    listening = false;
    micBtn.classList.remove('recording');
    micBtn.textContent = '🎙';
  });
  rec.addEventListener('error', () => {
    listening = false;
    micBtn.classList.remove('recording');
    micBtn.textContent = '🎙';
  });

  micBtn.addEventListener('click', () => {
    if (listening) { rec.stop(); return; }
    baseText = userInput.value.trim();
    try { rec.start(); listening = true; micBtn.classList.add('recording'); micBtn.textContent = '⏺'; }
    catch { /* already started */ }
  });
})();

// ── GitHub Gist sync (optional cross-device persistence) ──────────────────
// All requests are made directly from the browser to api.github.com, so the
// user's token never touches our server. We use a single "openclaw.json"
// file inside one Gist as the durable store.
const GH = {
  get token() { return localStorage.getItem('cc_gh_token') || ''; },
  set token(v) { v ? localStorage.setItem('cc_gh_token', v) : localStorage.removeItem('cc_gh_token'); },
  get gistId() { return localStorage.getItem('cc_gh_gist') || ''; },
  set gistId(v) { v ? localStorage.setItem('cc_gh_gist', v) : localStorage.removeItem('cc_gh_gist'); },
  get auto() { return localStorage.getItem('cc_gh_auto') === '1'; },
  set auto(v) { localStorage.setItem('cc_gh_auto', v ? '1' : '0'); },
};

const ghTokenInput = document.getElementById('ghTokenInput');
const ghGistInput  = document.getElementById('ghGistInput');
const syncStatus   = document.getElementById('syncStatus');
const syncPushBtn  = document.getElementById('syncPushBtn');
const syncPullBtn  = document.getElementById('syncPullBtn');
const syncAutoBtn  = document.getElementById('syncAutoBtn');

function setSyncStatus(text, cls = '') {
  if (!syncStatus) return;
  syncStatus.textContent = text;
  syncStatus.className = 'sync-status ' + cls;
}

function refreshSyncStatus() {
  if (!GH.token) return setSyncStatus('off');
  if (!GH.gistId) return setSyncStatus(GH.auto ? 'auto · no gist' : 'token only', 'warn');
  setSyncStatus(GH.auto ? 'auto-sync on' : 'manual', 'on');
}

if (ghTokenInput) {
  ghTokenInput.value = GH.token;
  ghTokenInput.addEventListener('input', () => { GH.token = ghTokenInput.value.trim(); refreshSyncStatus(); });
}
if (ghGistInput) {
  ghGistInput.value = GH.gistId;
  ghGistInput.addEventListener('input', () => { GH.gistId = ghGistInput.value.trim(); refreshSyncStatus(); });
}

async function ghCall(path, opts = {}) {
  if (!GH.token) throw new Error('No GitHub token configured');
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${GH.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
  return res.json();
}

function snapshot() {
  let mem = [];
  try { mem = JSON.parse(localStorage.getItem('cc_memory') || '[]'); } catch {}
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    sessions,
    memory: mem,
    settings: {
      provider: localStorage.getItem('cc_provider') || '',
      mode: localStorage.getItem('cc_mode') || 'auto',
    },
  };
}

async function pushSnapshot({ silent } = {}) {
  if (!GH.token) { if (!silent) alert('Add a GitHub token first.'); return; }
  setSyncStatus('pushing…', 'busy');
  try {
    const payload = { description: 'OpenClaw backup', public: false, files: { 'openclaw.json': { content: JSON.stringify(snapshot(), null, 2) } } };
    let result;
    if (GH.gistId) {
      result = await ghCall(`/gists/${GH.gistId}`, { method: 'PATCH', body: JSON.stringify({ files: payload.files }) });
    } else {
      result = await ghCall('/gists', { method: 'POST', body: JSON.stringify(payload) });
      GH.gistId = result.id;
      if (ghGistInput) ghGistInput.value = result.id;
    }
    setSyncStatus('synced ' + new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }), 'on');
  } catch (e) {
    setSyncStatus('push failed', 'warn');
    if (!silent) alert('Push failed: ' + e.message);
  }
}

async function pullSnapshot() {
  if (!GH.token || !GH.gistId) { alert('Need both a token and a Gist ID to pull.'); return; }
  setSyncStatus('pulling…', 'busy');
  try {
    const data = await ghCall(`/gists/${GH.gistId}`);
    const file = data.files?.['openclaw.json'];
    if (!file) throw new Error('Gist missing openclaw.json');
    const snap = JSON.parse(file.truncated && file.raw_url
      ? await (await fetch(file.raw_url)).text()
      : file.content);
    if (Array.isArray(snap.sessions)) {
      sessions = snap.sessions;
      try { localStorage.setItem('cc_sessions', JSON.stringify(sessions)); } catch {}
      renderSessions();
    }
    if (Array.isArray(snap.memory)) {
      try { localStorage.setItem('cc_memory', JSON.stringify(snap.memory)); } catch {}
      // Re-upload to server so the agent can recall.
      for (const m of snap.memory) {
        await fetch(`${API}/api/memory`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: m.text, tags: m.tags, importance: m.importance }),
        }).catch(() => {});
      }
      loadMemory();
    }
    setSyncStatus('pulled', 'on');
  } catch (e) {
    setSyncStatus('pull failed', 'warn');
    alert('Pull failed: ' + e.message);
  }
}

syncPushBtn?.addEventListener('click', () => pushSnapshot());
syncPullBtn?.addEventListener('click', pullSnapshot);
syncAutoBtn?.addEventListener('click', () => {
  GH.auto = !GH.auto;
  refreshSyncStatus();
  if (GH.auto) pushSnapshot({ silent: true });
});

// Debounced auto-push when sessions change.
let autoPushTimer = null;
window.addEventListener('cc:session-saved', () => {
  if (!GH.auto || !GH.token) return;
  clearTimeout(autoPushTimer);
  autoPushTimer = setTimeout(() => pushSnapshot({ silent: true }), 4000);
});

refreshSyncStatus();

// ── PWA: register service worker ──────────────────────────────────────────
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

stopBtn.addEventListener('click', () => {
  if (currentController) currentController.abort();
});

userInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    chatForm.dispatchEvent(new Event('submit'));
  }
  if (e.key === 'Escape') {
    slashMenu.hidden = true;
    if (isLoading && currentController) currentController.abort();
  }
});

attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  pendingFileText = await file.text();
  userInput.placeholder = `📎 ${file.name} attached — type your question…`;
  fileInput.value = '';
});

exportChatBtn.addEventListener('click', exportChat);

// ── Render helpers ─────────────────────────────────────────────────────────
function removeWelcome() { messagesEl.querySelector('.welcome')?.remove(); }

function showWelcome() {
  messagesEl.innerHTML = `
    <div class="welcome">
      <div class="welcome-icon">🐾</div>
      <h1>OpenClaw</h1>
      <p>Free, local-first, open-source AI assistant. Runs on Ollama &amp; LM Studio, falls back to keyless cloud providers.</p>
      <div class="provider-cards" id="providerCardsWelcome"></div>
      <div class="quick-prompts">
        <button class="quick-prompt" data-mode="agent" data-prompt="Search the web for the latest news about AI and summarize the top 3 stories.">🔎 Search web + summarize</button>
        <button class="quick-prompt" data-mode="agent" data-prompt="Create a file called notes.md with a short markdown checklist of 5 things to do today.">📝 Create a file</button>
        <button class="quick-prompt" data-mode="agent" data-prompt="Draft a short friendly email to support@example.com asking about a billing issue.">✉️ Draft an email</button>
        <button class="quick-prompt" data-mode="agent" data-prompt="Generate an image of a cozy cabin in the snowy mountains at sunset, painterly style.">🎨 Generate an image</button>
        <button class="quick-prompt" data-mode="agent" data-prompt="Calculate the monthly payment on a 30-year mortgage of 350000 at 6.5% interest.">🧮 Do a calculation</button>
        <button class="quick-prompt" data-mode="auto" data-prompt="Explain quantum computing like I am 10 years old.">💡 Explain something</button>
      </div>
      <p class="tip"><strong>🎉 No API key required.</strong> OpenClaw works out of the box via the free keyless Pollinations provider. Start Ollama or LM Studio locally for fully private inference. Type <code>/help</code> for commands.</p>
    </div>`;
  const cards = document.getElementById('providerCardsWelcome');
  for (const [id, p] of Object.entries(providers)) {
    const card = document.createElement('div');
    const connected = getAvailableProviders().some(a => a.id === id);
    card.className = 'provider-card' + (connected ? ' configured' : '');
    card.innerHTML = `<div class="card-name">${escapeHtml(p.name)}</div><div class="card-tag">${connected ? '✓ Connected' : 'FREE tier'}</div>`;
    card.addEventListener('click', () => {
      providerSelect.value = id;
      providerSelect.dispatchEvent(new Event('change'));
      sidebar.classList.remove('collapsed');
      sidebar.classList.add('open');
    });
    cards.appendChild(card);
  }
}

function appendAssistantShell(providerId = null) {
  removeWelcome();
  const div = document.createElement('div');
  div.className = 'message assistant';
  const name = providerId ? providers[providerId]?.name : providers[providerSelect.value]?.name || 'AI';
  div.innerHTML = `
    <div class="msg-meta">
      <span class="msg-avatar">🐾</span>
      <strong>${escapeHtml(name)}</strong>
      <span>${timestamp()}</span>
    </div>
    <div class="msg-bubble"></div>
    <div class="msg-actions">
      <button class="msg-action-btn copy-btn">Copy</button>
      <button class="msg-action-btn retry-btn">Retry</button>
    </div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function appendMessage(role, content, isError = false, providerId = null, isAskAll = false) {
  removeWelcome();
  const div = document.createElement('div');
  div.className = `message ${role}${isAskAll ? ' ask-all-group' : ''}`;
  const avatar = role === 'user' ? '🧑' : '🐾';
  const name = role === 'user'
    ? 'You'
    : (providerId ? providers[providerId]?.name : providers[providerSelect.value]?.name) || 'AI';
  div.innerHTML = `
    <div class="msg-meta">
      <span class="msg-avatar">${avatar}</span>
      <strong>${escapeHtml(name)}</strong>
      <span>${timestamp()}</span>
    </div>
    <div class="msg-bubble${isError ? ' error-bubble' : ''}">${renderMarkdown(content)}</div>
    <div class="msg-actions">
      <button class="msg-action-btn copy-btn">Copy</button>
      ${role === 'assistant' && !isAskAll ? '<button class="msg-action-btn retry-btn">Retry</button>' : ''}
    </div>`;
  enhanceCodeBlocks(div.querySelector('.msg-bubble'));
  wireMessageActions(div, content);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function wireMessageActions(div, content) {
  div.querySelector('.copy-btn')?.addEventListener('click', () => {
    navigator.clipboard.writeText(content);
    const btn = div.querySelector('.copy-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => { if (btn) btn.textContent = 'Copy'; }, 2000);
  });
  div.querySelector('.retry-btn')?.addEventListener('click', () => {
    if (messages[messages.length - 1]?.role === 'assistant') messages.pop();
    div.remove();
    setLoading(false);
    if (chatMode === 'agent') sendAgent([...messages]);
    else if (chatMode === 'ask-all') sendAskAll([...messages]);
    else sendAuto([...messages]);
  });
}

function enhanceCodeBlocks(root) {
  if (!root) return;
  root.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('.copy-code-btn')) return;
    const code = pre.querySelector('code');
    if (code && window.hljs && !code.classList.contains('hljs')) {
      try { hljs.highlightElement(code); } catch {}
    }
    const btn = document.createElement('button');
    btn.className = 'copy-code-btn';
    btn.textContent = 'Copy';
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(code?.textContent || pre.textContent);
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 2000);
    });
    pre.style.position = 'relative';
    pre.appendChild(btn);
  });
}

function appendAgentMessage(providerId, data) {
  removeWelcome();
  const div = document.createElement('div');
  div.className = 'message assistant';
  const name = providers[providerId]?.name || 'AI';
  const trace = data.trace || [];
  const traceHtml = trace.length
    ? `<details class="trace" open>
        <summary>🛠️ ${trace.length} tool call${trace.length === 1 ? '' : 's'}</summary>
        ${trace.map(renderTraceItem).join('')}
       </details>`
    : '';
  div.innerHTML = `
    <div class="msg-meta">
      <span class="msg-avatar">🤖</span>
      <strong>${escapeHtml(name)}</strong>
      <span class="agent-badge">agent</span>
      <span>${timestamp()}</span>
    </div>
    ${traceHtml}
    <div class="msg-bubble">${renderMarkdown(data.reply || '(no reply)')}</div>
    <div class="msg-actions">
      <button class="msg-action-btn copy-btn">Copy</button>
    </div>`;

  enhanceCodeBlocks(div.querySelector('.msg-bubble'));
  div.querySelector('.copy-btn')?.addEventListener('click', () => {
    navigator.clipboard.writeText(data.reply || '');
    const btn = div.querySelector('.copy-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => { if (btn) btn.textContent = 'Copy'; }, 2000);
  });

  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function renderTraceItem(item) {
  const { tool, args, result, step } = item;
  const argStr = (() => { try { return JSON.stringify(args, null, 2); } catch { return String(args); } })();
  let summary = '';
  if (tool === 'web_search' && result?.results?.length) {
    summary = `<ul class="trace-results">${result.results.map(r =>
      `<li><a href="${escapeAttr(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a><div class="trace-snippet">${escapeHtml(r.snippet || '')}</div></li>`
    ).join('')}</ul>`;
  } else if (tool === 'fetch_url') {
    summary = `<div class="trace-snippet">Fetched ${escapeHtml(result?.url || '')} (${result?.length || 0} chars)</div>`;
  } else if (tool === 'create_file' && result?.download_url) {
    summary = `<div class="trace-file">📄 <a href="${escapeAttr(result.download_url)}" download>${escapeHtml(result.filename)}</a> (${result.bytes} bytes)</div>`;
  } else if (tool === 'draft_email' && result?.mailto_link) {
    summary = `<div class="trace-file">✉️ <a href="${escapeAttr(result.mailto_link)}">Open draft to ${escapeHtml(result.to)}</a></div>`;
  } else if (tool === 'generate_image' && result?.image_url) {
    summary = `<div class="trace-image"><img src="${escapeAttr(result.image_url)}" alt="${escapeAttr(result.prompt || '')}" loading="lazy" /><div class="trace-snippet">${escapeHtml(result.prompt || '')}</div></div>`;
  } else if (tool === 'calculate' && typeof result?.result === 'number') {
    summary = `<div class="trace-snippet">Result: <strong>${escapeHtml(String(result.result))}</strong></div>`;
  } else if (tool === 'remember' && result?.id) {
    summary = `<div class="trace-snippet">💾 Saved to memory: <em>${escapeHtml(result.text)}</em></div>`;
  } else if (tool === 'recall' && result?.matches) {
    summary = result.matches.length
      ? `<ul class="trace-results">${result.matches.map(m => `<li><em>${escapeHtml(m.text)}</em></li>`).join('')}</ul>`
      : `<div class="trace-snippet">No relevant memories found.</div>`;
  } else if (tool === 'final_answer') {
    summary = ''; // don't render - the reply itself is shown below
  } else if (tool === 'read_file' && result?.filename) {
    summary = `<div class="trace-snippet">📖 Read ${escapeHtml(result.filename)} (${result.length} chars)</div>`;
  } else if (tool === 'current_time' && result?.iso) {
    summary = `<div class="trace-snippet">${escapeHtml(result.utc || result.iso)}</div>`;
  } else if (result?.error) {
    summary = `<div class="trace-error">Error: ${escapeHtml(result.error)}</div>`;
  }
  return `
    <div class="trace-item">
      <div class="trace-head">Step ${step}: <code>${escapeHtml(tool)}</code></div>
      <pre class="trace-args">${escapeHtml(argStr)}</pre>
      ${summary}
    </div>`;
}

async function loadFiles() {
  if (!filesList) return;
  try {
    const res = await fetch(`${API}/api/files`);
    const data = await res.json();
    if (!data.files || data.files.length === 0) {
      filesList.innerHTML = '<li class="empty">No files yet</li>';
      return;
    }
    filesList.innerHTML = data.files.map(f =>
      `<li><a href="${escapeAttr(f.url)}" download>${escapeHtml(f.name)}</a> <span class="file-size">${f.bytes}B</span></li>`
    ).join('');
  } catch {
    filesList.innerHTML = '<li class="empty">Could not load</li>';
  }
}

if (refreshFilesBtn) refreshFilesBtn.addEventListener('click', loadFiles);

// ── Memory panel ──────────────────────────────────────────────────────────
function renderMemoryList(entries) {
  if (!memoryList) return;
  if (!entries || entries.length === 0) {
    memoryList.innerHTML = '<li class="empty">No memories yet</li>';
    return;
  }
  memoryList.innerHTML = entries.slice(0, 40).map(e => `
    <li data-id="${escapeAttr(e.id)}">
      <span class="mem-text">${escapeHtml(e.text)}</span>
      <div class="mem-meta">
        ${(e.tags || []).map(t => `<span class="mem-tag">${escapeHtml(t)}</span>`).join('')}
        ${e.importance >= 3 ? '<span class="mem-imp">★</span>' : ''}
        <button class="icon-btn mini mem-del" data-del="${escapeAttr(e.id)}" title="Forget">×</button>
      </div>
    </li>`).join('');
}

// Memory survives Vercel cold starts (which wipe /tmp) by mirroring every
// fetched entry into localStorage and re-uploading any that the server is
// missing on subsequent loads.
async function loadMemory() {
  if (!memoryList) return;
  let serverEntries = [];
  try {
    const res = await fetch(`${API}/api/memory`);
    const data = await res.json();
    serverEntries = Array.isArray(data.entries) ? data.entries : [];
  } catch {
    memoryList.innerHTML = '<li class="empty">Could not reach server</li>';
  }

  let localEntries = [];
  try { localEntries = JSON.parse(localStorage.getItem('cc_memory') || '[]'); } catch {}

  // Re-upload local entries the server lost (cold start, redeploy, etc.).
  const serverIds = new Set(serverEntries.map(e => e.id));
  const missing = localEntries.filter(e => !serverIds.has(e.id));
  if (missing.length) {
    await Promise.all(missing.map(e =>
      fetch(`${API}/api/memory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: e.text, tags: e.tags, importance: e.importance }),
      }).catch(() => {})
    ));
    try {
      const r2 = await fetch(`${API}/api/memory`);
      const d2 = await r2.json();
      serverEntries = Array.isArray(d2.entries) ? d2.entries : serverEntries;
    } catch {}
  }

  // Mirror the truth to localStorage as the durable store.
  try { localStorage.setItem('cc_memory', JSON.stringify(serverEntries)); } catch {}
  renderMemoryList(serverEntries);
}

memoryList?.addEventListener('click', async e => {
  const del = e.target.closest('.mem-del');
  if (!del) return;
  await fetch(`${API}/api/memory/${encodeURIComponent(del.dataset.del)}`, { method: 'DELETE' });
  loadMemory();
});

refreshMemoryBtn?.addEventListener('click', loadMemory);
clearMemoryBtn?.addEventListener('click', async () => {
  if (!confirm('Forget everything in long-term memory?')) return;
  await fetch(`${API}/api/memory`, { method: 'DELETE' });
  loadMemory();
});

// ── Quick prompts on the welcome screen ────────────────────────────────────
document.addEventListener('click', e => {
  const qp = e.target.closest('.quick-prompt');
  if (!qp) return;
  const mode = qp.dataset.mode;
  const prompt = qp.dataset.prompt;
  if (mode) setChatMode(mode);
  userInput.value = prompt || '';
  userInput.focus();
  userInput.dispatchEvent(new Event('input'));
});

function appendTyping(providerName = 'AI') {
  removeWelcome();
  const id = 'typing-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const div = document.createElement('div');
  div.className = 'message assistant';
  div.id = id;
  div.innerHTML = `
    <div class="msg-meta"><span class="msg-avatar">🐾</span><strong>${escapeHtml(providerName)}</strong></div>
    <div class="msg-bubble">
      <div class="typing-bubble">
        <span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>
      </div>
    </div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return id;
}

function removeTyping(id) { document.getElementById(id)?.remove(); }

function setLoading(state, showStop = false) {
  isLoading = state;
  sendBtn.disabled = state;
  sendIcon.style.display = state ? 'none' : 'inline';
  loadingIcon.style.display = state ? 'inline' : 'none';
  stopBtn.style.display = state && showStop ? 'flex' : 'none';
  sendBtn.style.display = state && showStop ? 'none' : 'flex';
}

function timestamp() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Sessions ───────────────────────────────────────────────────────────────
function loadSessions() {
  try { sessions = JSON.parse(localStorage.getItem('cc_sessions') || '[]'); } catch { sessions = []; }
  currentSessionId = localStorage.getItem('cc_current_session') || null;

  // If we don't have a current session pointer but there ARE saved chats,
  // auto-resume the most recent one. This is what users expect — opening
  // the tab should restore their last conversation, not greet them with a
  // blank welcome screen every time.
  if (!currentSessionId && sessions.length) {
    const mostRecent = [...sessions].sort((a, b) => (b.updated || 0) - (a.updated || 0))[0];
    if (mostRecent) currentSessionId = mostRecent.id;
  }

  if (currentSessionId) {
    const s = sessions.find(s => s.id === currentSessionId);
    if (s) {
      messages = s.messages || [];
      chatMode = s.mode || 'auto';
      if (messages.length) replayMessages();
      localStorage.setItem('cc_current_session', currentSessionId);
    }
  }
}

function replayMessages() {
  messagesEl.innerHTML = '';
  for (const m of messages) {
    if (m.role === 'user' || m.role === 'assistant') {
      appendMessage(m.role, m.content);
    }
  }
}

function newSession() {
  messages = [];
  currentSessionId = null;
  localStorage.removeItem('cc_current_session');
  showWelcome();
  renderSessions();
}

function saveCurrentSession() {
  if (messages.length === 0) return;
  if (!currentSessionId) {
    currentSessionId = 's_' + Date.now();
    localStorage.setItem('cc_current_session', currentSessionId);
    sessions.unshift({ id: currentSessionId, messages: [...messages], mode: chatMode, updated: Date.now(), title: sessionTitle(messages) });
  } else {
    const s = sessions.find(s => s.id === currentSessionId);
    if (s) {
      s.messages = [...messages];
      s.mode = chatMode;
      s.updated = Date.now();
      s.title = sessionTitle(messages);
    } else {
      sessions.unshift({ id: currentSessionId, messages: [...messages], mode: chatMode, updated: Date.now(), title: sessionTitle(messages) });
    }
  }
  sessions = sessions.slice(0, 30);
  try { localStorage.setItem('cc_sessions', JSON.stringify(sessions)); } catch {}
  renderSessions();
  window.dispatchEvent(new CustomEvent('cc:session-saved'));
}

function sessionTitle(msgs) {
  const first = msgs.find(m => m.role === 'user');
  if (!first) return 'New chat';
  const t = first.content.replace(/```[\s\S]*?```/g, '').replace(/\s+/g, ' ').trim();
  return t.length > 48 ? t.slice(0, 48) + '…' : t;
}

function renderSessions() {
  if (!sessionsList) return;
  if (sessions.length === 0) {
    sessionsList.innerHTML = '<li class="empty">No past chats</li>';
    return;
  }
  sessionsList.innerHTML = sessions.slice(0, 12).map(s => `
    <li class="${s.id === currentSessionId ? 'active' : ''}" data-id="${s.id}">
      <span class="session-title">${escapeHtml(s.title || 'Untitled')}</span>
      <button class="icon-btn mini session-del" data-del="${s.id}" title="Delete">×</button>
    </li>`).join('');
}

sessionsList?.addEventListener('click', e => {
  const del = e.target.closest('.session-del');
  if (del) {
    const id = del.dataset.del;
    sessions = sessions.filter(s => s.id !== id);
    try { localStorage.setItem('cc_sessions', JSON.stringify(sessions)); } catch {}
    if (id === currentSessionId) { currentSessionId = null; messages = []; showWelcome(); }
    renderSessions();
    return;
  }
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const s = sessions.find(x => x.id === li.dataset.id);
  if (!s) return;
  currentSessionId = s.id;
  messages = [...(s.messages || [])];
  chatMode = s.mode || 'auto';
  setChatMode(chatMode);
  localStorage.setItem('cc_current_session', currentSessionId);
  replayMessages();
  renderSessions();
});

function exportChat() {
  if (messages.length === 0) return;
  const title = sessionTitle(messages);
  const md = `# ${title}\n\n*Exported from OpenClaw — ${new Date().toLocaleString()}*\n\n---\n\n` +
    messages.map(m => {
      const who = m.role === 'user' ? '**You**' : m.role === 'assistant' ? '**OpenClaw**' : `**${m.role}**`;
      return `### ${who}\n\n${m.content}\n`;
    }).join('\n');
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (title.replace(/[^\w\-]/g, '_').slice(0, 40) || 'chat') + '.md';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Persist settings ───────────────────────────────────────────────────────
function loadSettings() {
  const sys = localStorage.getItem('cc_system');
  if (sys) systemPrompt.value = sys;
  const temp = localStorage.getItem('cc_temp');
  if (temp) { tempRange.value = temp; tempVal.textContent = temp; }
  const mode = localStorage.getItem('cc_mode');
  if (mode && ['auto', 'agent', 'ask-all'].includes(mode)) {
    chatMode = mode;
    modeToggle.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    modeHint.textContent = MODE_HINTS[mode] || '';
  }
}

systemPrompt.addEventListener('input', () => localStorage.setItem('cc_system', systemPrompt.value));
tempRange.addEventListener('input', () => localStorage.setItem('cc_temp', tempRange.value));

// ── Boot ───────────────────────────────────────────────────────────────────
init().then(() => { loadFiles(); loadMemory(); });
// Refresh provider status every 30s so local LLMs appearing/disappearing reflect.
setInterval(async () => {
  try {
    const res = await fetch(`${API}/api/providers`);
    const next = await res.json();
    let changed = false;
    for (const [id, p] of Object.entries(next)) {
      if (providers[id]?.configured !== p.configured) changed = true;
    }
    providers = next;
    if (changed) { buildProviderUI(); updateStatus(); }
  } catch { /* ignore */ }
}, 30_000);
