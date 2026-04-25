/* ── OpenClaw frontend app ─────────────────────────────────────────────── */

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

// Keyless cloud first, then key-based cloud (sidebar key or server env).
const PROVIDER_ORDER = [
  'pollinations',
  'groq', 'cerebras', 'openrouter', 'gemini', 'together', 'deepseek', 'cohere', 'huggingface',
];
// Local backends are never in this list — no auto-fallback to them. Opt-in via checkbox only.
const LOCAL_PROVIDER_IDS = ['ollama', 'lmstudio', 'llamacpp'];

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
const showLocalProviders = document.getElementById('showLocalProviders');
const keyPersistHint = document.getElementById('keyPersistHint');

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

// ── Trust / privacy strip (shared markup for welcome + sidebar) ───────────
const SOURCE_REPO_URL = 'https://github.com/openclaw/openclaw';

const TRUST_STRIP_HTML = `
  <section class="trust-strip" aria-label="Trust and privacy">
    <div class="trust-strip-inner">
      <a class="trust-card trust-card-link" href="${SOURCE_REPO_URL}" target="_blank" rel="noopener noreferrer" title="View source on GitHub">
        <span class="trust-card-icon" aria-hidden="true">📖</span>
        <span class="trust-card-text">100% Open Source</span>
      </a>
      <div class="trust-card" title="Local models keep chats on your device">
        <span class="trust-card-icon" aria-hidden="true">🔒</span>
        <span class="trust-card-text">Private by default (local-first)</span>
      </div>
      <div class="trust-card" title="Keyless cloud when no local LLM is available">
        <span class="trust-card-icon" aria-hidden="true">☁️</span>
        <span class="trust-card-text">Free cloud fallback</span>
      </div>
      <div class="trust-card" title="Agent mode with tools and long-term memory">
        <span class="trust-card-icon" aria-hidden="true">🧠</span>
        <span class="trust-card-text">Agent mode + tools + memory</span>
      </div>
      <div class="trust-card" title="This deployment does not persist your conversations">
        <span class="trust-card-icon" aria-hidden="true">🚫</span>
        <span class="trust-card-text">No data stored</span>
      </div>
    </div>
  </section>`;

function fillTrustStripSlots(root = document) {
  root.querySelectorAll('[data-trust-strip]').forEach(el => {
    el.innerHTML = TRUST_STRIP_HTML;
  });
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
  fillTrustStripSlots();
}

function isLocalBackendShown() {
  return !!(showLocalProviders && showLocalProviders.checked);
}

function shouldListProvider(id, p) {
  if (!p.hidden) return true;
  return isLocalBackendShown() && LOCAL_PROVIDER_IDS.includes(id);
}

function buildProviderUI() {
  providerSelect.innerHTML = '';
  providerCards.innerHTML = '';
  for (const [id, p] of Object.entries(providers)) {
    if (!shouldListProvider(id, p)) continue;

    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = p.name + (p.configured ? ' ✓' : '');
    opt.disabled = p.local && !p.configured;
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
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', `Select provider ${p.name}`);
    card.addEventListener('click', () => {
      if (p.local && !p.configured) return;
      providerSelect.value = id;
      providerSelect.dispatchEvent(new Event('change'));
      sidebar.classList.remove('collapsed');
      sidebar.classList.add('open');
      syncSidebarAria();
    });
    card.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        card.click();
      }
    });
    providerCards.appendChild(card);
  }
}

function restoreProvider() {
  let saved = localStorage.getItem('cc_provider');
  if (saved && !providers[saved]) {
    localStorage.removeItem('cc_provider');
    saved = null;
  }
  if (saved && providers[saved]?.hidden && !shouldListProvider(saved, providers[saved])) {
    localStorage.removeItem('cc_provider');
    saved = null;
  }
  const listedIds = [...providerSelect.options].map(o => o.value);
  if (saved && !listedIds.includes(saved)) {
    localStorage.removeItem('cc_provider');
    saved = null;
  }
  const firstAvailable = getAvailableProviders()[0]?.id;
  const firstListed = listedIds[0];
  const target = (saved && providers[saved]) ? saved : (firstAvailable || firstListed);
  if (target && listedIds.includes(target)) providerSelect.value = target;
  else if (firstListed) providerSelect.value = firstListed;
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
    if (keyPersistHint) keyPersistHint.style.display = 'none';
  } else {
    keySection.style.display = '';
    if (keyPersistHint) keyPersistHint.style.display = '';
    const savedKey = localStorage.getItem(`cc_key_${id}`) || '';
    apiKeyInput.value = savedKey;
    getKeyLink.href = p.signupUrl;
    getKeyLink.textContent = `Get free ${p.name} key →`;
  }

  updateStatus();
  localStorage.setItem('cc_provider', id);
});

function persistCurrentApiKey() {
  const id = providerSelect.value;
  const p = providers[id];
  if (!p || p.keyless) return;
  const trimmed = apiKeyInput.value.trim();
  try {
    if (trimmed) localStorage.setItem(`cc_key_${id}`, trimmed);
    else localStorage.removeItem(`cc_key_${id}`);
    if (keyPersistHint) {
      keyPersistHint.textContent = trimmed
        ? 'Saved · stored in this browser for this exact site URL.'
        : 'Paste a key to save it here. Each Vercel URL has its own storage — use one production domain so keys are not split.';
      keyPersistHint.style.color = '';
    }
  } catch (e) {
    if (keyPersistHint) {
      keyPersistHint.textContent = 'Could not save (private mode or storage full). Try another browser or tab.';
      keyPersistHint.style.color = 'var(--warning)';
    }
  }
}

apiKeyInput.addEventListener('input', () => {
  persistCurrentApiKey();
  updateStatus();
});
apiKeyInput.addEventListener('change', persistCurrentApiKey);
apiKeyInput.addEventListener('paste', () => {
  queueMicrotask(() => {
    persistCurrentApiKey();
    updateStatus();
  });
});
apiKeyInput.addEventListener('blur', persistCurrentApiKey);
window.addEventListener('pagehide', persistCurrentApiKey);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') persistCurrentApiKey();
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

document.getElementById('topbarModeToggle')?.addEventListener('click', e => {
  const btn = e.target.closest('.topbar-mode-btn');
  if (!btn) return;
  setChatMode(btn.dataset.mode);
});
function setChatMode(mode) {
  chatMode = mode;
  modeToggle.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  document.querySelectorAll('#topbarModeToggle .topbar-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  syncModeButtonsAriaPressed();
  syncTopbarModeAriaPressed();
  modeHint.textContent = MODE_HINTS[mode] || '';
  updateStatus();
  localStorage.setItem('cc_mode', mode);
  if (mode === 'agent') loadFiles();
}

function syncModeButtonsAriaPressed() {
  modeToggle.querySelectorAll('.mode-btn').forEach(b => {
    b.setAttribute('aria-pressed', b.dataset.mode === chatMode ? 'true' : 'false');
  });
}

function syncTopbarModeAriaPressed() {
  document.querySelectorAll('#topbarModeToggle .topbar-mode-btn').forEach(b => {
    b.setAttribute('aria-pressed', b.dataset.mode === chatMode ? 'true' : 'false');
  });
}

function isSidebarExpanded() {
  const mobile = window.matchMedia('(max-width: 640px)').matches;
  if (mobile) return sidebar.classList.contains('open');
  return !sidebar.classList.contains('collapsed');
}

function syncSidebarAria() {
  if (!sidebarToggle) return;
  const expanded = isSidebarExpanded();
  sidebarToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
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
      if (p.keyless) {
        // Keyless cloud: always usable. Keyless local: only when reachable (server probed).
        if (p.local && !p.configured) return null;
        return { id, key: '' };
      }
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
            if (!hadAny) { bodyEl.innerHTML = ''; hadAny = true; }
            bodyEl.innerHTML = renderMarkdown(buffer) + '<span class="cursor">▋</span>';
            messagesEl.scrollTop = messagesEl.scrollHeight;
          } else if (event === 'done') {
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

// ── Agent mode ────────────────────────────────────────────────────────────
const TOOL_PROGRESS_LABELS = {
  plan: 'Planning',
  web_search: 'Searching web',
  fetch_url: 'Reading page',
  read_file: 'Reading file',
  create_file: 'Writing file',
  remember: 'Remembering',
  recall: 'Recalling',
  calculate: 'Calculating',
  generate_image: 'Generating image',
  draft_email: 'Drafting email',
  current_time: 'Checking time',
  extract_structured: 'Extracting data',
  summarize_text: 'Summarizing',
  weather: 'Checking weather',
  final_answer: 'Writing answer',
};

function progressLabelFor(tool, args) {
  const base = TOOL_PROGRESS_LABELS[tool] || `Using ${tool}`;
  if (!args) return base;
  if (tool === 'web_search' && args.query) return `${base}: "${String(args.query).slice(0, 60)}"`;
  if (tool === 'fetch_url' && args.url)    return `${base}: ${String(args.url).slice(0, 70)}`;
  if (tool === 'read_file' && args.path)   return `${base}: ${args.path}`;
  if (tool === 'create_file' && args.path) return `${base}: ${args.path}`;
  if (tool === 'calculate' && args.expression) return `${base}: ${String(args.expression).slice(0, 60)}`;
  if (tool === 'remember' && args.text)    return `${base}: "${String(args.text).slice(0, 50)}"`;
  return base;
}

function setTypingProgress(typingId, label) {
  const div = document.getElementById(typingId);
  if (!div) return;
  const bubble = div.querySelector('.msg-bubble');
  if (!bubble) return;
  bubble.innerHTML = `
    <div class="typing-progress">
      <span class="typing-bubble">
        <span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>
      </span>
      <span class="typing-label">${escapeHtml(label)}</span>
    </div>`;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function sendAgent(msgs) {
  const available = getAvailableProviders({ toolsOnly: true });
  if (available.length === 0) {
    appendMessage('assistant', 'Agent mode needs a tool-capable provider (Pollinations, Groq, or Together).', true);
    return;
  }
  const { id, key } = available[0];
  const name = providers[id].name;
  const typingId = appendTyping(`${name} (Agent)`);
  currentController = new AbortController();
  setLoading(true, true);

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
      signal: currentController.signal,
    });

    if (!res.ok || !res.body) {
      const fallback = await res.json().catch(() => ({}));
      removeTyping(typingId);
      appendMessage('assistant', `Agent error: ${fallback.error || res.statusText}`, true, id);
      setStatus('error', 'Agent failed');
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let finalData = null;
    let streamErr = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
        let event = 'message', data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        let obj; try { obj = JSON.parse(data); } catch { continue; }
        if (event === 'start') {
          setTypingProgress(typingId, 'Thinking…');
        } else if (event === 'step') {
          setTypingProgress(typingId, progressLabelFor(obj.tool, obj.args));
        } else if (event === 'done') {
          finalData = obj;
        } else if (event === 'error') {
          streamErr = obj.message || 'stream error';
        }
      }
    }

    removeTyping(typingId);
    if (streamErr) {
      appendMessage('assistant', `Agent error: ${streamErr}`, true, id);
      setStatus('error', 'Agent failed');
      return;
    }
    if (!finalData) {
      appendMessage('assistant', 'Agent returned no final answer.', true, id);
      setStatus('error', 'Agent failed');
      return;
    }
    appendAgentMessage(id, finalData);
    messages.push({ role: 'assistant', content: finalData.reply || '' });
    setStatus('online', `${name} answered (${finalData.steps} step${finalData.steps === 1 ? '' : 's'})`);
    activePill.textContent = `🤖 ${name}`;
    activePill.className = 'provider-pill online';
    saveCurrentSession();
    loadFiles();
  } catch (err) {
    removeTyping(typingId);
    if (err.name !== 'AbortError') {
      appendMessage('assistant', `Agent error: ${err.message}`, true);
      setStatus('error', 'Agent failed');
    } else {
      setStatus('online', 'Stopped');
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
  const images = (typeof window.__takeOutgoingImages === 'function') ? window.__takeOutgoingImages() : [];
  if (!text && !pendingFileText && images.length === 0) return;

  // Slash commands (only if no images)
  if (text.startsWith('/') && images.length === 0) {
    const handled = handleSlashCommand(text);
    if (handled) { userInput.value = ''; userInput.style.height = 'auto'; return; }
  }

  if (pendingFileText) {
    text = text ? `${text}\n\n\`\`\`\n${pendingFileText}\n\`\`\`` : `\`\`\`\n${pendingFileText}\n\`\`\``;
    pendingFileText = null;
    userInput.placeholder = 'Ask anything, paste images, drop files… (Shift+Enter for new line)';
  }

  userInput.value = '';
  userInput.style.height = 'auto';
  removeWelcome();

  // Build multimodal content if images are attached, otherwise plain string.
  let content;
  if (images.length) {
    const parts = [];
    if (text) parts.push({ type: 'text', text });
    for (const im of images) parts.push({ type: 'image_url', image_url: { url: im.dataUrl } });
    content = parts;
  } else {
    content = text;
  }

  appendMessage('user', content);
  messages.push({ role: 'user', content });
  saveCurrentSession();

  if (chatMode === 'ask-all')     await sendAskAll([...messages]);
  else if (chatMode === 'agent')  await sendAgent([...messages]);
  else                            await sendAuto([...messages]);
});

// ── Slash commands ─────────────────────────────────────────────────────────
const SLASH_COMMANDS = [
  { cmd: '/clear',    desc: 'Clear the current conversation' },
  { cmd: '/new',      desc: 'Start a new conversation' },
  { cmd: '/export',   desc: 'Download this conversation as markdown' },
  { cmd: '/chat',     desc: 'Switch to chat mode' },
  { cmd: '/agent',    desc: 'Switch to agent mode (tools)' },
  { cmd: '/askall',   desc: 'Switch to ask-all mode' },
  { cmd: '/image ',   desc: 'Agent: generate an image from a prompt' },
  { cmd: '/search ',  desc: 'Agent: web search + summary' },
  { cmd: '/file ',    desc: 'Agent: create a text file' },
  { cmd: '/weather ', desc: 'Agent: current weather for a place' },
  { cmd: '/summarize ', desc: 'Agent: summarize a URL or pasted text' },
  { cmd: '/remember ',desc: 'Save a durable fact to memory' },
  { cmd: '/recall ',  desc: 'Look up facts from memory' },
  { cmd: '/help',     desc: 'Show this list' },
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
    case '/weather': {
      setChatMode('agent');
      userInput.value = `What's the weather in ${arg || 'my area'}? Use the weather tool.`;
      return false;
    }
    case '/summarize': {
      setChatMode('agent');
      userInput.value = /^https?:\/\//.test(arg)
        ? `Fetch ${arg} and summarize the key points in a short bulleted list.`
        : `Summarize this, using summarize_text if it's long: ${arg}`;
      return false;
    }
    case '/remember': {
      setChatMode('agent');
      userInput.value = `Remember this: ${arg}`;
      return false;
    }
    case '/recall': {
      setChatMode('agent');
      userInput.value = `Recall anything you know about: ${arg}. If nothing relevant, say so.`;
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
        `<div class="slash-item" role="option" tabindex="0" data-cmd="${escapeAttr(m.cmd)}" aria-label="Insert slash command ${escapeAttr(m.cmd.trim())}: ${escapeAttr(m.desc)}"><code>${m.cmd}</code><span>${escapeHtml(m.desc)}</span></div>`
      ).join('');
      return;
    }
  }
  slashMenu.hidden = true;
});

function pickSlashItem(item) {
  userInput.value = item.dataset.cmd;
  slashMenu.hidden = true;
  userInput.focus();
  if (!item.dataset.cmd.endsWith(' ')) {
    chatForm.dispatchEvent(new Event('submit'));
  }
}

slashMenu.addEventListener('click', e => {
  const item = e.target.closest('.slash-item');
  if (!item) return;
  pickSlashItem(item);
});

slashMenu.addEventListener('keydown', e => {
  const item = e.target.closest('.slash-item');
  if (!item || (e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault();
  pickSlashItem(item);
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
  syncSidebarAria();
});

document.getElementById('sidebarClose')?.addEventListener('click', () => {
  sidebar.classList.remove('open');
  sidebar.classList.add('collapsed');
  syncSidebarAria();
});

window.addEventListener('resize', () => syncSidebarAria());

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
  if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    chatForm.dispatchEvent(new Event('submit', { cancelable: true }));
  }
  if (e.key === 'Escape') {
    slashMenu.hidden = true;
    if (isLoading && currentController) currentController.abort();
  }
});

attachBtn.addEventListener('click', () => fileInput.click());

exportChatBtn.addEventListener('click', exportChat);

// ── Render helpers ─────────────────────────────────────────────────────────
function removeWelcome() { messagesEl.querySelector('.welcome')?.remove(); }

function showWelcome() {
  messagesEl.innerHTML = `
    <div class="welcome">
      <div class="welcome-icon">🐾</div>
      <h1>OpenClaw</h1>
      <p>Free, open-source AI assistant. Uses the keyless Pollinations cloud by default; add API keys (e.g. Groq) for faster models.</p>
      <div data-trust-strip></div>
      <div class="provider-cards" id="providerCardsWelcome"></div>
      <div class="quick-prompts" role="group" aria-label="Example prompts">
        <button type="button" class="quick-prompt" data-mode="agent" data-prompt="Search the web for the latest news about AI and summarize the top 3 stories." aria-label="Example: search the web and summarize AI news">🔎 Search web + summarize</button>
        <button type="button" class="quick-prompt" data-mode="agent" data-prompt="Create a file called notes.md with a short markdown checklist of 5 things to do today." aria-label="Example: create a checklist file">📝 Create a file</button>
        <button type="button" class="quick-prompt" data-mode="agent" data-prompt="Draft a short friendly email to support@example.com asking about a billing issue." aria-label="Example: draft a support email">✉️ Draft an email</button>
        <button type="button" class="quick-prompt" data-mode="agent" data-prompt="Generate an image of a cozy cabin in the snowy mountains at sunset, painterly style." aria-label="Example: generate a painterly cabin image">🎨 Generate an image</button>
        <button type="button" class="quick-prompt" data-mode="agent" data-prompt="Calculate the monthly payment on a 30-year mortgage of 350000 at 6.5% interest." aria-label="Example: mortgage payment calculation">🧮 Do a calculation</button>
        <button type="button" class="quick-prompt" data-mode="auto" data-prompt="Explain quantum computing like I am 10 years old." aria-label="Example: simple quantum computing explanation">💡 Explain something</button>
      </div>
      <p class="tip"><strong>🎉 No API key required</strong> to start — Pollinations works out of the box. Paste a Groq key in the sidebar for much faster chat and agent runs. Type <code>/help</code> for commands.</p>
    </div>`;
  fillTrustStripSlots(messagesEl);
  const cards = document.getElementById('providerCardsWelcome');
  for (const [id, p] of Object.entries(providers)) {
    if (!shouldListProvider(id, p)) continue;
    const card = document.createElement('div');
    const connected = getAvailableProviders().some(a => a.id === id);
    card.className = 'provider-card' + (connected ? ' configured' : '');
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', `Select provider ${p.name}`);
    card.innerHTML = `<div class="card-name">${escapeHtml(p.name)}</div><div class="card-tag">${connected ? '✓ Connected' : 'FREE tier'}</div>`;
    card.addEventListener('click', () => {
      providerSelect.value = id;
      providerSelect.dispatchEvent(new Event('change'));
      sidebar.classList.remove('collapsed');
      sidebar.classList.add('open');
      syncSidebarAria();
    });
    card.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        card.click();
      }
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
      <button type="button" class="msg-action-btn copy-btn" aria-label="Copy assistant message to clipboard">Copy</button>
      <button type="button" class="msg-action-btn retry-btn" aria-label="Retry this assistant response">Retry</button>
    </div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function splitMultimodal(content) {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: String(content ?? ''), images: [] };
  let text = '';
  const images = [];
  for (const part of content) {
    if (part?.type === 'text') text += (text ? '\n' : '') + (part.text || '');
    else if (part?.type === 'image_url') images.push(part.image_url?.url || '');
  }
  return { text, images: images.filter(Boolean) };
}

function appendMessage(role, content, isError = false, providerId = null, isAskAll = false) {
  removeWelcome();
  const div = document.createElement('div');
  div.className = `message ${role}${isAskAll ? ' ask-all-group' : ''}`;
  const avatar = role === 'user' ? '🧑' : '🐾';
  const name = role === 'user'
    ? 'You'
    : (providerId ? providers[providerId]?.name : providers[providerSelect.value]?.name) || 'AI';
  const { text, images } = splitMultimodal(content);
  const imgHtml = images.map(u =>
    `<img src="${escapeAttr(u)}" class="msg-image" alt="attached image" style="max-width:220px;max-height:220px;border-radius:8px;margin:4px 4px 0 0;">`
  ).join('');
  div.innerHTML = `
    <div class="msg-meta">
      <span class="msg-avatar">${avatar}</span>
      <strong>${escapeHtml(name)}</strong>
      <span>${timestamp()}</span>
    </div>
    <div class="msg-bubble${isError ? ' error-bubble' : ''}">${imgHtml}${renderMarkdown(text)}</div>
    <div class="msg-actions">
      <button type="button" class="msg-action-btn copy-btn" aria-label="${role === 'user' ? 'Copy your message to clipboard' : 'Copy assistant message to clipboard'}">Copy</button>
      ${role === 'user' && images.length === 0 ? '<button type="button" class="msg-action-btn edit-btn" title="Edit and resend" aria-label="Edit and resend this message">Edit</button>' : ''}
      ${role === 'assistant' ? '<button type="button" class="msg-action-btn speak-btn" title="Read aloud" aria-label="Read message aloud">🔊</button>' : ''}
      ${role === 'assistant' && !isAskAll ? '<button type="button" class="msg-action-btn retry-btn" aria-label="Retry this assistant response">Retry</button>' : ''}
    </div>`;
  enhanceCodeBlocks(div.querySelector('.msg-bubble'));
  wireMessageActions(div, text);
  injectArtifactTriggers(div.querySelector('.msg-bubble'));
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
  div.querySelector('.speak-btn')?.addEventListener('click', () => speakText(content, div.querySelector('.speak-btn')));
  div.querySelector('.edit-btn')?.addEventListener('click', () => startEditUserMessage(div, content));
}

function startEditUserMessage(div, original) {
  const bubble = div.querySelector('.msg-bubble');
  const actions = div.querySelector('.msg-actions');
  if (!bubble || bubble.querySelector('textarea')) return;
  const ta = document.createElement('textarea');
  ta.className = 'edit-textarea';
  ta.value = original;
  ta.rows = Math.min(12, Math.max(2, original.split('\n').length));
  const save = document.createElement('button');
  save.className = 'msg-action-btn';
  save.textContent = 'Save & resend';
  const cancel = document.createElement('button');
  cancel.className = 'msg-action-btn';
  cancel.textContent = 'Cancel';
  const savedBubble = bubble.innerHTML;
  const savedActions = actions ? actions.innerHTML : '';
  bubble.innerHTML = '';
  bubble.appendChild(ta);
  if (actions) { actions.innerHTML = ''; actions.append(save, cancel); }
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  cancel.addEventListener('click', () => {
    bubble.innerHTML = savedBubble;
    if (actions) actions.innerHTML = savedActions;
    wireMessageActions(div, original);
  });

  save.addEventListener('click', () => {
    const newText = ta.value.trim();
    if (!newText) return;
    const allMsgDivs = Array.from(messagesEl.querySelectorAll('.message'));
    const domIdx = allMsgDivs.indexOf(div);
    let msgIdx = -1, counted = -1;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'user' || messages[i].role === 'assistant') {
        counted++;
        if (counted === domIdx) { msgIdx = i; break; }
      }
    }
    if (msgIdx === -1) return;
    messages = messages.slice(0, msgIdx);
    while (div.nextSibling) div.nextSibling.remove();
    div.remove();
    appendMessage('user', newText);
    messages.push({ role: 'user', content: newText });
    if (chatMode === 'agent') sendAgent([...messages]);
    else if (chatMode === 'ask-all') sendAskAll([...messages]);
    else sendAuto([...messages]);
  });
}

// ── Text-to-speech ────────────────────────────────────────────────────────
let currentUtterance = null;
function speakText(text, btn) {
  if (!('speechSynthesis' in window)) return;
  if (currentUtterance) {
    speechSynthesis.cancel();
    const active = document.querySelector('.speak-btn.speaking');
    if (active) active.classList.remove('speaking');
    if (currentUtterance.__btn === btn) { currentUtterance = null; return; }
  }
  const clean = String(text || '').replace(/```[\s\S]*?```/g, ' code block ')
                                  .replace(/`([^`]+)`/g, '$1')
                                  .replace(/\*\*([^*]+)\*\*/g, '$1')
                                  .replace(/[*_#>~]/g, '')
                                  .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
                                  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  const u = new SpeechSynthesisUtterance(clean);
  u.rate = 1.05;
  u.__btn = btn;
  u.onstart = () => btn?.classList.add('speaking');
  u.onend = u.onerror = () => { btn?.classList.remove('speaking'); if (currentUtterance === u) currentUtterance = null; };
  currentUtterance = u;
  speechSynthesis.speak(u);
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
    btn.type = 'button';
    btn.className = 'copy-code-btn';
    btn.textContent = 'Copy';
    btn.setAttribute('aria-label', 'Copy code block to clipboard');
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
      <button type="button" class="msg-action-btn copy-btn" aria-label="Copy assistant message to clipboard">Copy</button>
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
      `<li><a href="${escapeAttr(f.url)}" download aria-label="Download ${escapeAttr(f.name)}">${escapeHtml(f.name)}</a> <span class="file-size">${f.bytes}B</span></li>`
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
        <button type="button" class="icon-btn mini mem-del" data-del="${escapeAttr(e.id)}" title="Forget" aria-label="Forget this memory">×</button>
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

function sortedSessions(arr = sessions) {
  return [...arr].sort((a, b) => {
    if (!!b.pinned - !!a.pinned) return !!b.pinned - !!a.pinned;
    return (b.updated || 0) - (a.updated || 0);
  });
}

function renderSessions() {
  if (!sessionsList) return;
  if (sessions.length === 0) {
    sessionsList.innerHTML = '<li class="empty">No past chats</li>';
    return;
  }
  sessionsList.innerHTML = sortedSessions().slice(0, 30).map(s => `
    <li class="${s.id === currentSessionId ? 'active' : ''}${s.pinned ? ' pinned' : ''}" data-id="${s.id}">
      <button class="icon-btn mini session-pin" data-pin="${s.id}" title="${s.pinned ? 'Unpin' : 'Pin'}">${s.pinned ? '★' : '☆'}</button>
      <span class="session-title">${escapeHtml(s.title || 'Untitled')}</span>
      <button type="button" class="icon-btn mini session-del" data-del="${s.id}" title="Delete" aria-label="Delete conversation ${escapeAttr(s.title || 'Untitled')}">×</button>
    </li>`).join('');
}

sessionsList?.addEventListener('click', e => {
  const pin = e.target.closest('.session-pin');
  if (pin) {
    e.stopPropagation();
    const id = pin.dataset.pin;
    const s = sessions.find(x => x.id === id);
    if (s) {
      s.pinned = !s.pinned;
      try { localStorage.setItem('cc_sessions', JSON.stringify(sessions)); } catch {}
      renderSessions();
      window.dispatchEvent(new CustomEvent('cc:session-saved'));
    }
    return;
  }
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
  if (showLocalProviders) {
    showLocalProviders.checked = localStorage.getItem('cc_show_local_providers') === '1';
  }
  syncModeButtonsAriaPressed();
  syncTopbarModeAriaPressed();
}

systemPrompt.addEventListener('input', () => localStorage.setItem('cc_system', systemPrompt.value));
tempRange.addEventListener('input', () => localStorage.setItem('cc_temp', tempRange.value));

showLocalProviders?.addEventListener('change', () => {
  localStorage.setItem('cc_show_local_providers', showLocalProviders.checked ? '1' : '0');
  const cur = providerSelect.value;
  if (!showLocalProviders.checked && providers[cur]?.local) {
    localStorage.removeItem('cc_provider');
  }
  buildProviderUI();
  restoreProvider();
  updateStatus();
});

// ── Light/dark theme toggle ──────────────────────────────────────────────
(function theme() {
  const btn = document.getElementById('themeBtn');
  const saved = localStorage.getItem('cc_theme');
  const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)').matches;
  const initial = saved || (prefersLight ? 'light' : 'dark');
  document.documentElement.classList.toggle('light', initial === 'light');
  btn?.addEventListener('click', () => {
    const isLight = document.documentElement.classList.toggle('light');
    localStorage.setItem('cc_theme', isLight ? 'light' : 'dark');
  });
})();

// ── Session search filter ────────────────────────────────────────────────
const sessionSearch = document.getElementById('sessionSearch');
let sessionFilter = '';
sessionSearch?.addEventListener('input', () => {
  sessionFilter = sessionSearch.value.toLowerCase();
  renderSessions();
});
// Monkey-patch renderSessions to respect the filter.
const _origRenderSessions = renderSessions;
renderSessions = function () {
  if (!sessionsList) return;
  const visible = sessionFilter
    ? sessions.filter(s => (s.title || '').toLowerCase().includes(sessionFilter)
        || (s.messages || []).some(m => typeof m.content === 'string' && m.content.toLowerCase().includes(sessionFilter)))
    : sessions;
  if (visible.length === 0) {
    sessionsList.innerHTML = `<li class="empty">${sessionFilter ? 'No matches' : 'No past chats'}</li>`;
    return;
  }
  sessionsList.innerHTML = sortedSessions(visible).slice(0, 30).map(s => `
    <li class="${s.id === currentSessionId ? 'active' : ''}${s.pinned ? ' pinned' : ''}" data-id="${s.id}">
      <button type="button" class="icon-btn mini session-pin" data-pin="${s.id}" title="${s.pinned ? 'Unpin' : 'Pin'}" aria-label="${s.pinned ? 'Unpin' : 'Pin'} conversation ${escapeAttr(s.title || 'Untitled')}">${s.pinned ? '★' : '☆'}</button>
      <span class="session-title">${escapeHtml(s.title || 'Untitled')}</span>
      <button type="button" class="icon-btn mini session-del" data-del="${s.id}" title="Delete" aria-label="Delete conversation ${escapeAttr(s.title || 'Untitled')}">×</button>
    </li>`).join('');
};
renderSessions();

// ── Prompt presets ───────────────────────────────────────────────────────
const PRESETS = [
  { id: 'default', name: 'OpenClaw (default)', prompt: 'You are OpenClaw, a powerful, friendly AI assistant. Be concise, accurate, and helpful.' },
  { id: 'coder', name: 'Coding buddy', prompt: 'You are a senior software engineer. Give complete, runnable code with clear explanations. Prefer idiomatic, production-ready patterns. Include tests when useful.' },
  { id: 'tutor', name: 'Patient tutor', prompt: 'You are a patient tutor. Break ideas into small steps, ask Socratic questions, and check for understanding before moving on.' },
  { id: 'copy', name: 'Copywriter', prompt: 'You are a sharp copywriter. Write punchy, clear, benefit-focused prose. Prefer active voice. Offer 2-3 variants when asked.' },
  { id: 'research', name: 'Research analyst', prompt: 'You are a careful research analyst. When uncertain, say so. Cite sources with URLs. Distinguish fact from inference. Summarize, then dive deep.' },
  { id: 'therapist', name: 'Empathetic listener', prompt: 'You are a warm, non-judgmental listener. Reflect feelings, validate, and ask gentle follow-ups before offering suggestions.' },
  { id: 'brainstorm', name: 'Brainstorm partner', prompt: 'You are a lateral-thinking brainstorm partner. Offer many ideas across the quality spectrum. Build on user input. Defer judgment.' },
  { id: 'chef', name: 'Home chef', prompt: 'You are a friendly home chef. Suggest recipes that match the ingredients and tools available. Explain techniques briefly and practically.' },
];
const presetSelect = document.getElementById('presetSelect');
if (presetSelect) {
  for (const p of PRESETS) {
    const opt = document.createElement('option');
    opt.value = p.id; opt.textContent = p.name;
    presetSelect.appendChild(opt);
  }
  presetSelect.value = localStorage.getItem('cc_preset') || 'default';
  presetSelect.addEventListener('change', () => {
    const p = PRESETS.find(x => x.id === presetSelect.value);
    if (!p) return;
    systemPrompt.value = p.prompt;
    systemPrompt.dispatchEvent(new Event('input'));
    localStorage.setItem('cc_preset', p.id);
  });
}

// ── Image attach / paste / drop for vision ───────────────────────────────
let pendingImages = [];  // [{name, dataUrl}]
const chipsEl = document.getElementById('attachedChips');

function renderChips() {
  if (!chipsEl) return;
  chipsEl.innerHTML = pendingImages.map((im, i) => `
    <span class="chip">
      <img src="${escapeAttr(im.dataUrl)}" alt="${escapeAttr(im.name)}">
      ${escapeHtml(im.name || 'image')}
      <button type="button" data-rm="${i}" title="Remove">✕</button>
    </span>`).join('');
}
chipsEl?.addEventListener('click', (e) => {
  const rm = e.target.closest('[data-rm]');
  if (!rm) return;
  pendingImages.splice(+rm.dataset.rm, 1);
  renderChips();
});

async function handleFiles(fileList) {
  const arr = Array.from(fileList || []);
  for (const f of arr) {
    if (f.type.startsWith('image/')) {
      const dataUrl = await new Promise((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.readAsDataURL(f);
      });
      pendingImages.push({ name: f.name, dataUrl });
    } else {
      pendingFileText = await f.text();
      userInput.placeholder = `📎 ${f.name} attached — type your question…`;
    }
  }
  renderChips();
}

// Override attach button behavior to use new multi-file flow.
fileInput.addEventListener('change', async () => {
  await handleFiles(fileInput.files);
  fileInput.value = '';
}, { capture: true });

// Paste image from clipboard.
userInput.addEventListener('paste', async (e) => {
  const items = Array.from(e.clipboardData?.items || []);
  const images = items.filter(i => i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean);
  if (images.length) {
    e.preventDefault();
    await handleFiles(images);
  }
});

// Drag & drop.
document.body.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); document.body.classList.add('drop-hover'); }
});
document.body.addEventListener('dragleave', () => document.body.classList.remove('drop-hover'));
document.body.addEventListener('drop', async (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  document.body.classList.remove('drop-hover');
  await handleFiles(e.dataTransfer.files);
});

// Hook into send: if images are pending, convert the outgoing message to
// a multimodal content-array and clear the chips. Done by listening before
// the form submit handler runs — we mutate the textarea and stash images
// via a window-level side channel read by the submit handler.
window.__takeOutgoingImages = function () {
  const out = pendingImages.slice();
  pendingImages = [];
  renderChips();
  return out;
};

// ── Artifact-style preview panel ─────────────────────────────────────────
const artifactPanel = document.getElementById('artifactPanel');
const artifactFrame = document.getElementById('artifactFrame');
const artifactTitle = document.getElementById('artifactTitle');
let lastArtifactSrc = '';

function openArtifact(src, title = 'Preview') {
  if (!artifactPanel || !artifactFrame) return;
  lastArtifactSrc = src;
  artifactTitle.textContent = title;
  artifactFrame.srcdoc = src;
  artifactPanel.hidden = false;
}
document.getElementById('artifactCloseBtn')?.addEventListener('click', () => {
  if (artifactPanel) { artifactPanel.hidden = true; artifactFrame.srcdoc = ''; }
});
document.getElementById('artifactReloadBtn')?.addEventListener('click', () => {
  if (artifactFrame) artifactFrame.srcdoc = lastArtifactSrc;
});

// Add a "Preview" button to any HTML/SVG fenced block inside a message.
function injectArtifactTriggers(root) {
  if (!root) return;
  root.querySelectorAll('pre > code').forEach((code) => {
    const cls = code.className || '';
    const isHtml = /language-html|language-xml|language-svg/i.test(cls);
    const isSvg  = /^<svg[\s\S]*<\/svg>/i.test(code.textContent.trim());
    if (!isHtml && !isSvg) return;
    const pre = code.parentElement;
    if (pre.querySelector('.artifact-trigger')) return;
    const btn = document.createElement('button');
    btn.className = 'artifact-trigger';
    btn.textContent = '▶︎ Preview';
    btn.addEventListener('click', () => {
      const src = isSvg
        ? `<!doctype html><meta charset=utf-8><style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#fff}svg{max-width:95vw;max-height:95vh}</style>${code.textContent}`
        : code.textContent;
      openArtifact(src, isSvg ? 'SVG preview' : 'HTML preview');
    });
    pre.appendChild(btn);
  });
}

// ── Command palette (Ctrl/Cmd+K) ─────────────────────────────────────────
const paletteOverlay = document.getElementById('paletteOverlay');
const paletteInput = document.getElementById('paletteInput');
const paletteResults = document.getElementById('paletteResults');
let paletteItems = [];
let paletteSel = 0;

function buildPaletteItems() {
  const items = [];
  items.push({ icon: '💬', label: 'New chat', sub: '⌘/Ctrl+N', run: () => newSession() });
  items.push({ icon: '☰', label: 'Toggle settings sidebar', sub: '', run: () => { sidebarToggle?.click(); } });
  items.push({ icon: '🌓', label: 'Toggle theme', sub: '', run: () => document.getElementById('themeBtn').click() });
  items.push({ icon: '🔄', label: 'Clear current chat', sub: '', run: () => clearBtn.click() });
  items.push({ icon: '↓',  label: 'Export chat as markdown', sub: '', run: () => exportChat() });
  items.push({ icon: '🎙', label: 'Start voice input', sub: '', run: () => document.getElementById('micBtn')?.click() });
  for (const m of ['auto', 'agent', 'ask-all']) {
    items.push({ icon: '🎛', label: `Mode: ${m}`, sub: '', run: () => setChatMode(m) });
  }
  for (const [id, p] of Object.entries(providers)) {
    items.push({ icon: '⚡', label: `Use ${p.name}`, sub: p.configured ? '✓ ready' : (p.keyless ? 'free' : 'needs key'), run: () => { providerSelect.value = id; providerSelect.dispatchEvent(new Event('change')); } });
  }
  for (const s of sessions.slice(0, 20)) {
    items.push({ icon: '💭', label: s.title || 'Untitled', sub: 'chat', run: () => { currentSessionId = s.id; messages = [...(s.messages || [])]; chatMode = s.mode || 'auto'; setChatMode(chatMode); localStorage.setItem('cc_current_session', currentSessionId); replayMessages(); renderSessions(); } });
  }
  for (const p of PRESETS) {
    items.push({ icon: '📝', label: `Preset: ${p.name}`, sub: '', run: () => { if (presetSelect) { presetSelect.value = p.id; presetSelect.dispatchEvent(new Event('change')); } } });
  }
  return items;
}

function renderPalette() {
  if (!paletteResults) return;
  const q = paletteInput.value.trim().toLowerCase();
  const filtered = q
    ? paletteItems.filter(i => i.label.toLowerCase().includes(q) || (i.sub || '').toLowerCase().includes(q))
    : paletteItems;
  paletteSel = Math.min(paletteSel, Math.max(0, filtered.length - 1));
  paletteResults.innerHTML = filtered.slice(0, 50).map((it, i) => `
    <li role="option" aria-selected="${i === paletteSel ? 'true' : 'false'}" data-i="${i}" class="${i === paletteSel ? 'selected' : ''}" tabindex="${i === paletteSel ? '0' : '-1'}">
      <span class="p-icon" aria-hidden="true">${it.icon}</span>
      <span>${escapeHtml(it.label)}</span>
      <span class="p-sub">${escapeHtml(it.sub || '')}</span>
    </li>`).join('');
  paletteResults._filtered = filtered;
}

function openPalette() {
  paletteItems = buildPaletteItems();
  paletteInput.value = '';
  paletteSel = 0;
  renderPalette();
  paletteOverlay.hidden = false;
  paletteOverlay.setAttribute('aria-hidden', 'false');
  setTimeout(() => paletteInput.focus(), 10);
}
function closePalette() {
  if (!paletteOverlay) return;
  paletteOverlay.hidden = true;
  paletteOverlay.setAttribute('aria-hidden', 'true');
}

document.getElementById('paletteBtn')?.addEventListener('click', openPalette);
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'n' && paletteOverlay?.hidden) {
    const inSidebarField = e.target?.closest?.('#sidebar') && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
    if (inSidebarField) return;
    e.preventDefault();
    newSession();
    return;
  }
  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (paletteOverlay && !paletteOverlay.hidden) closePalette();
    else openPalette();
    return;
  }
  if (mod && e.key === 'Enter' && paletteOverlay?.hidden) {
    e.preventDefault();
    chatForm.dispatchEvent(new Event('submit', { cancelable: true }));
    return;
  }
  if (!paletteOverlay || paletteOverlay.hidden) return;
  if (e.key === 'Escape') { e.preventDefault(); closePalette(); return; }
  const list = paletteResults._filtered || [];
  if (e.key === 'ArrowDown') { e.preventDefault(); paletteSel = (paletteSel + 1) % Math.max(1, list.length); renderPalette(); }
  if (e.key === 'ArrowUp')   { e.preventDefault(); paletteSel = (paletteSel - 1 + list.length) % Math.max(1, list.length); renderPalette(); }
  if (e.key === 'Enter')     { e.preventDefault(); const pick = list[paletteSel]; if (pick) { closePalette(); pick.run(); } }
});
paletteInput?.addEventListener('input', () => { paletteSel = 0; renderPalette(); });
paletteResults?.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  const it = (paletteResults._filtered || [])[+li.dataset.i];
  if (it) { closePalette(); it.run(); }
});
paletteOverlay?.addEventListener('click', (e) => { if (e.target === paletteOverlay) closePalette(); });

// ── Scroll-to-bottom button ──────────────────────────────────────────────
(function scrollToBottom() {
  const btn = document.getElementById('scrollBottomBtn');
  if (!btn || !messagesEl) return;
  const threshold = 120;
  function nearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < threshold;
  }
  function update() { btn.hidden = nearBottom(); }
  messagesEl.addEventListener('scroll', update, { passive: true });
  btn.addEventListener('click', () => {
    messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
  });
  new MutationObserver(update).observe(messagesEl, { childList: true, subtree: true, characterData: true });
  update();
})();

// ── Follow-up suggestion chips ───────────────────────────────────────────
const followupChips = document.getElementById('followupChips');

function showFollowups(items) {
  if (!followupChips || !items?.length) return;
  followupChips.innerHTML = items.map(t =>
    `<button type="button" class="followup-chip">${escapeHtml(t)}</button>`).join('');
  followupChips.hidden = false;
}
function clearFollowups() {
  if (!followupChips) return;
  followupChips.innerHTML = '';
  followupChips.hidden = true;
}
followupChips?.addEventListener('click', (e) => {
  const btn = e.target.closest('.followup-chip');
  if (!btn) return;
  userInput.value = btn.textContent;
  clearFollowups();
  userInput.focus();
  chatForm.dispatchEvent(new Event('submit', { cancelable: true }));
});

function extractFollowups(reply) {
  if (!reply || reply.length < 40) return [];
  const lines = reply.split('\n').map(l => l.trim()).filter(Boolean);
  const suggestions = [];
  for (const l of lines) {
    const q = l.match(/^[\-\*\d\.\)\s]*(.+\?)\s*$/);
    if (q && q[1].length < 90 && q[1].length > 12) suggestions.push(q[1]);
  }
  const seen = new Set();
  return suggestions.filter(s => !seen.has(s) && seen.add(s)).slice(0, 3);
}

// Clear follow-ups whenever user sends a message; refresh them after each
// assistant reply gets saved.
chatForm?.addEventListener('submit', clearFollowups);
window.addEventListener('cc:session-saved', () => {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return clearFollowups();
  const text = typeof last.content === 'string' ? last.content : '';
  showFollowups(extractFollowups(text));
});

// ── Boot ───────────────────────────────────────────────────────────────────
init().then(() => {
  loadFiles();
  loadMemory();
  syncSidebarAria();
});
// Refresh provider status periodically (e.g. env keys on the server).
setInterval(async () => {
  try {
    const res = await fetch(`${API}/api/providers`);
    const next = await res.json();
    let changed = false;
    for (const [id, p] of Object.entries(next)) {
      if (providers[id]?.configured !== p.configured || providers[id]?.reachable !== p.reachable) changed = true;
    }
    providers = next;
    if (changed) { buildProviderUI(); updateStatus(); }
  } catch { /* ignore */ }
}, 30_000);
