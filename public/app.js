/* ── CloudClaw frontend app ──────────────────────────────────────────── */

const API = '';  // same-origin; set full URL if backend is separate

// ── State ─────────────────────────────────────────────────────────────────
let providers   = {};
let messages    = [];            // {role, content}[] — conversation history
let isLoading   = false;
let chatMode    = 'auto';        // 'auto' | 'agent' | 'ask-all'
let pendingFileText = null;
let currentController = null;    // AbortController for in-flight requests
let sessions    = [];            // [{id, customTitle, mode, messages, updated}]
let currentSessionId = null;
let sessionSearchQuery = '';

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
const examplePromptsBar = document.getElementById('examplePromptsBar');
const chatForm       = document.getElementById('chatForm');
const userInput      = document.getElementById('userInput');
const sendBtn        = document.getElementById('sendBtn');
const sendIcon       = document.getElementById('sendIcon');
const loadingIcon    = document.getElementById('loadingIcon');
const stopBtn        = document.getElementById('stopBtn');
const clearBtn       = document.getElementById('clearBtn');
const newChatBtn     = document.getElementById('newChatBtn');
const historyRail    = document.getElementById('historyRail');
const historyRailPin = document.getElementById('historyRailPin');
const historyRailCloseMobile = document.getElementById('historyRailCloseMobile');
const historyToggle  = document.getElementById('historyToggle');
const historyBackdrop = document.getElementById('historyBackdrop');
const historySearchInput = document.getElementById('historySearchInput');
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

const HISTORY_MQ = window.matchMedia('(max-width: 900px)');
function isHistoryMobile() { return HISTORY_MQ.matches; }

function migrateSessionShape(list) {
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    if (!('customTitle' in s)) {
      const legacy = s.title != null && String(s.title).trim() ? String(s.title).trim() : null;
      s.customTitle = legacy;
      delete s.title;
    }
  }
}

function defaultThreadTitle(msgs) {
  const first = msgs?.find(m => m.role === 'user');
  if (!first) return 'New chat';
  const t = String(first.content).replace(/```[\s\S]*?```/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return 'New chat';
  return t.length > 40 ? t.slice(0, 40) + '…' : t;
}

function displaySessionTitle(s) {
  const t = (s.customTitle != null && String(s.customTitle).trim()) ? String(s.customTitle).trim() : defaultThreadTitle(s.messages || []);
  return t || 'New chat';
}

function threadPreviewSnippet(msgs) {
  const last = [...(msgs || [])].reverse().find(m => m.role === 'user' || m.role === 'assistant');
  if (!last?.content) return 'No messages yet';
  let t = String(last.content).replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return 'No messages yet';
  return t.length > 90 ? t.slice(0, 90) + '…' : t;
}

function formatThreadDate(ts) {
  const d = new Date(ts || Date.now());
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString([], sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}

function getFilteredSessions() {
  const q = sessionSearchQuery.trim().toLowerCase();
  let list = [...sessions];
  if (q) {
    list = list.filter(s => {
      const title = displaySessionTitle(s).toLowerCase();
      const prev = threadPreviewSnippet(s.messages).toLowerCase();
      const when = formatThreadDate(s.updated).toLowerCase();
      return title.includes(q) || prev.includes(q) || when.includes(q);
    });
  }
  return list;
}

function closeHistoryDrawer() {
  if (!historyRail) return;
  historyRail.classList.remove('history-rail--open');
  document.body.classList.remove('history-open');
  if (historyBackdrop) historyBackdrop.hidden = true;
}

function openHistoryDrawer() {
  if (!historyRail) return;
  historyRail.classList.add('history-rail--open');
  if (isHistoryMobile()) {
    document.body.classList.add('history-open');
    if (historyBackdrop) historyBackdrop.hidden = false;
  }
}

function toggleHistoryDrawer() {
  if (!historyRail) return;
  if (historyRail.classList.contains('history-rail--open')) closeHistoryDrawer();
  else openHistoryDrawer();
}

function applyHistoryRailLayout() {
  if (!historyRail || !historyRailPin) return;
  if (isHistoryMobile()) {
    historyRail.classList.remove('history-rail--collapsed');
    historyRailPin.setAttribute('aria-hidden', 'true');
    closeHistoryDrawer();
  } else {
    historyRail.classList.remove('history-rail--open');
    document.body.classList.remove('history-open');
    if (historyBackdrop) historyBackdrop.hidden = true;
    historyRailPin.removeAttribute('aria-hidden');
    const collapsed = localStorage.getItem('cc_history_rail_collapsed') === '1';
    historyRail.classList.toggle('history-rail--collapsed', collapsed);
    historyRailPin.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    historyRailPin.textContent = collapsed ? '▶' : '◀';
    historyRailPin.title = collapsed ? 'Expand history' : 'Collapse history';
  }
}

function initHistoryRail() {
  applyHistoryRailLayout();
  const onMq = () => applyHistoryRailLayout();
  if (HISTORY_MQ.addEventListener) HISTORY_MQ.addEventListener('change', onMq);
  else HISTORY_MQ.addListener(onMq);

  historyRailPin?.addEventListener('click', () => {
    if (isHistoryMobile()) return;
    const next = !historyRail.classList.contains('history-rail--collapsed');
    historyRail.classList.toggle('history-rail--collapsed', next);
    localStorage.setItem('cc_history_rail_collapsed', next ? '1' : '0');
    applyHistoryRailLayout();
  });

  historyToggle?.addEventListener('click', () => {
    if (isHistoryMobile()) toggleHistoryDrawer();
    else {
      const collapsed = historyRail.classList.toggle('history-rail--collapsed');
      localStorage.setItem('cc_history_rail_collapsed', collapsed ? '1' : '0');
      applyHistoryRailLayout();
    }
  });

  historyRailCloseMobile?.addEventListener('click', () => closeHistoryDrawer());
  historyBackdrop?.addEventListener('click', () => closeHistoryDrawer());

  historySearchInput?.addEventListener('input', () => {
    sessionSearchQuery = historySearchInput.value;
    renderSessions();
  });
}

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  loadSettings();
  loadSessions();
  initHistoryRail();
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
    const res = await fetch(`${API}/api/agent`, {
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
    const data = await res.json();
    removeTyping(typingId);
    if (!res.ok || data.error) {
      appendMessage('assistant', `Agent error: ${data.error || res.statusText}`, true, id);
      setStatus('error', 'Agent failed');
      return;
    }
    appendAgentMessage(id, data);
    messages.push({ role: 'assistant', content: data.reply || '' });
    setStatus('online', `${name} answered (${data.steps} step${data.steps === 1 ? '' : 's'})`);
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
  const opening = sidebar.classList.contains('collapsed');
  if (opening && isHistoryMobile()) closeHistoryDrawer();
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
function updateExamplePromptsVisibility() {
  if (!examplePromptsBar) return;
  const hasWelcome = !!messagesEl.querySelector('.welcome');
  const hasThread = messages.length > 0;
  examplePromptsBar.classList.toggle('is-conversation-active', hasThread && !hasWelcome);
}

function removeWelcome() {
  messagesEl.querySelector('.welcome')?.remove();
  updateExamplePromptsVisibility();
}

function showWelcome() {
  messagesEl.innerHTML = `
    <div class="welcome">
      <div class="welcome-icon">🐾</div>
      <h1>OpenClaw</h1>
      <p>Free, local-first, open-source AI assistant. Runs on Ollama &amp; LM Studio, falls back to keyless cloud providers.</p>
      <div class="provider-cards" id="providerCardsWelcome"></div>
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
  updateExamplePromptsVisibility();
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
async function loadMemory() {
  if (!memoryList) return;
  try {
    const res = await fetch(`${API}/api/memory`);
    const data = await res.json();
    if (!data.entries || data.entries.length === 0) {
      memoryList.innerHTML = '<li class="empty">No memories yet</li>';
      return;
    }
    memoryList.innerHTML = data.entries.slice(0, 40).map(e => `
      <li data-id="${escapeAttr(e.id)}">
        <span class="mem-text">${escapeHtml(e.text)}</span>
        <div class="mem-meta">
          ${(e.tags || []).map(t => `<span class="mem-tag">${escapeHtml(t)}</span>`).join('')}
          ${e.importance >= 3 ? '<span class="mem-imp">★</span>' : ''}
          <button class="icon-btn mini mem-del" data-del="${escapeAttr(e.id)}" title="Forget">×</button>
        </div>
      </li>`).join('');
  } catch {
    memoryList.innerHTML = '<li class="empty">Could not load</li>';
  }
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

// ── Example prompt cards (welcome bar + any in-page duplicates) ───────────
document.addEventListener('click', e => {
  const qp = e.target.closest('.example-prompt-card');
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
  migrateSessionShape(sessions);
  currentSessionId = localStorage.getItem('cc_current_session') || null;
  if (currentSessionId) {
    const s = sessions.find(x => x.id === currentSessionId);
    if (s) {
      messages = [...(s.messages || [])];
      chatMode = s.mode || 'auto';
      if (messages.length) replayMessages();
      else {
        currentSessionId = null;
        localStorage.removeItem('cc_current_session');
      }
    } else {
      currentSessionId = null;
      localStorage.removeItem('cc_current_session');
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
  updateExamplePromptsVisibility();
}

function newSession() {
  messages = [];
  currentSessionId = null;
  localStorage.removeItem('cc_current_session');
  showWelcome();
  renderSessions();
  closeHistoryDrawer();
}

function saveCurrentSession() {
  if (messages.length === 0) {
    if (currentSessionId) {
      const s = sessions.find(x => x.id === currentSessionId);
      if (s) {
        s.messages = [];
        s.updated = Date.now();
        sessions = sessions.slice(0, 30);
        try { localStorage.setItem('cc_sessions', JSON.stringify(sessions)); } catch {}
      }
    }
    renderSessions();
    return;
  }
  if (!currentSessionId) {
    currentSessionId = 's_' + Date.now();
    localStorage.setItem('cc_current_session', currentSessionId);
    sessions.unshift({
      id: currentSessionId,
      messages: [...messages],
      mode: chatMode,
      updated: Date.now(),
      customTitle: null,
    });
  } else {
    const s = sessions.find(x => x.id === currentSessionId);
    if (s) {
      s.messages = [...messages];
      s.mode = chatMode;
      s.updated = Date.now();
    } else {
      sessions.unshift({
        id: currentSessionId,
        messages: [...messages],
        mode: chatMode,
        updated: Date.now(),
        customTitle: null,
      });
    }
  }
  sessions = sessions.slice(0, 30);
  try { localStorage.setItem('cc_sessions', JSON.stringify(sessions)); } catch {}
  renderSessions();
}

function renderSessions() {
  if (!sessionsList) return;
  if (sessions.length === 0) {
    sessionsList.innerHTML = '<li class="empty">No conversations yet</li>';
    return;
  }
  const filtered = getFilteredSessions();
  if (filtered.length === 0) {
    sessionsList.innerHTML = '<li class="empty">No matches</li>';
    return;
  }
  sessionsList.innerHTML = filtered.slice(0, 100).map(s => {
    const title = displaySessionTitle(s);
    const preview = threadPreviewSnippet(s.messages);
    const when = formatThreadDate(s.updated);
    return `
    <li class="session-row ${s.id === currentSessionId ? 'active' : ''}" data-id="${escapeAttr(s.id)}">
      <div class="session-row-top">
        <span class="session-title">${escapeHtml(title)}</span>
        <span class="session-time">${escapeHtml(when)}</span>
      </div>
      <div class="session-preview">${escapeHtml(preview)}</div>
      <div class="session-row-actions">
        <button type="button" class="icon-btn mini session-rename" data-rename="${escapeAttr(s.id)}" title="Rename">✎</button>
        <button type="button" class="icon-btn mini session-del" data-del="${escapeAttr(s.id)}" title="Delete">×</button>
      </div>
    </li>`;
  }).join('');
}

sessionsList?.addEventListener('click', e => {
  const renameBtn = e.target.closest('.session-rename');
  if (renameBtn) {
    e.stopPropagation();
    const id = renameBtn.dataset.rename;
    const s = sessions.find(x => x.id === id);
    if (!s) return;
    const defTitle = displaySessionTitle(s);
    const next = window.prompt('Conversation title', defTitle);
    if (next === null) return;
    const t = next.trim();
    s.customTitle = t || null;
    s.updated = Date.now();
    try { localStorage.setItem('cc_sessions', JSON.stringify(sessions)); } catch {}
    renderSessions();
    return;
  }
  const del = e.target.closest('.session-del');
  if (del) {
    e.stopPropagation();
    const id = del.dataset.del;
    sessions = sessions.filter(s => s.id !== id);
    try { localStorage.setItem('cc_sessions', JSON.stringify(sessions)); } catch {}
    if (id === currentSessionId) {
      currentSessionId = null;
      messages = [];
      localStorage.removeItem('cc_current_session');
      showWelcome();
    }
    renderSessions();
    return;
  }
  const li = e.target.closest('li.session-row[data-id]');
  if (!li) return;
  const s = sessions.find(x => x.id === li.dataset.id);
  if (!s) return;
  currentSessionId = s.id;
  messages = [...(s.messages || [])];
  chatMode = s.mode || 'auto';
  setChatMode(chatMode);
  localStorage.setItem('cc_current_session', currentSessionId);
  if (messages.length) replayMessages();
  else showWelcome();
  renderSessions();
  closeHistoryDrawer();
});

function exportChat() {
  if (messages.length === 0) return;
  const cur = sessions.find(x => x.id === currentSessionId);
  const title = displaySessionTitle({ messages, customTitle: cur?.customTitle ?? null });
  const md = `# ${title}\n\n*Exported from CloudClaw — ${new Date().toLocaleString()}*\n\n---\n\n` +
    messages.map(m => {
      const who = m.role === 'user' ? '**You**' : m.role === 'assistant' ? '**CloudClaw**' : `**${m.role}**`;
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
init().then(() => {
  loadFiles();
  loadMemory();
  updateExamplePromptsVisibility();
});
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
