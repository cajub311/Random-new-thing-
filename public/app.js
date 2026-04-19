/* ── CloudClaw frontend app ──────────────────────────────────────────── */

const API = '';  // same-origin; set full URL if backend is separate

// ── State ─────────────────────────────────────────────────────────────────
let providers   = {};
let messages    = [];            // {role, content}[] — conversation history
let isLoading   = false;
let chatMode    = 'auto';        // 'auto' | 'agent' | 'ask-all'
let pendingFileText = null;
let currentController = null;    // AbortController for in-flight requests
/** @typedef {{ id: string, messages: {role:string,content:string}[], mode: string, updated: number, title?: string, titleLocked?: boolean, titleUser?: string, preview?: string }} Session */
let sessions    = [];            // Session[]
let currentSessionId = null;
let historySearchQuery = '';

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
const exportChatBtn  = document.getElementById('exportChatBtn');
const exportAllJsonBtn = document.getElementById('exportAllJsonBtn');
const exportAllMdBtn = document.getElementById('exportAllMdBtn');
const historyRail      = document.getElementById('historyRail');
const historyRailToggle = document.getElementById('historyRailToggle');
const historySearchInput = document.getElementById('historySearchInput');
const historyList      = document.getElementById('historyList');
const headerNewChatBtn = document.getElementById('headerNewChatBtn');
const bottomNav        = document.getElementById('bottomNav');
const bottomNavChat    = document.getElementById('bottomNavChat');
const bottomNavHistory = document.getElementById('bottomNavHistory');
const bottomNavSettings= document.getElementById('bottomNavSettings');
const sheetBackdrop    = document.getElementById('sheetBackdrop');
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

// ── Session persistence: localStorage + IndexedDB fallback for large data ──
const LS_SESSIONS = 'cc_sessions';
const LS_SESSIONS_LARGE = 'cc_sessions_large';
const IDB_NAME = 'openclaw_cc';
const IDB_STORE = 'kv';
const IDB_SESSIONS_KEY = 'sessions_blob';

function idbOpen() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error('no idb'));
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(key) {
  return idbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const r = tx.objectStore(IDB_STORE).get(key);
    r.onsuccess = () => { db.close(); resolve(r.result ?? null); };
    r.onerror = () => { db.close(); reject(r.error); };
  }));
}

function idbSet(key, value) {
  return idbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  }));
}

function idbDelete(key) {
  return idbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  }));
}

function stripForPreview(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/[#>*_\-[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sessionPreviewFromMessages(msgs) {
  if (!msgs?.length) return '';
  const last = msgs[msgs.length - 1];
  const t = stripForPreview(last?.content || '');
  return t.length > 140 ? t.slice(0, 140) + '…' : t;
}

function autoTitleFromMessages(msgs) {
  const first = msgs?.find(m => m.role === 'user');
  if (!first) return 'New chat';
  const t = stripForPreview(first.content);
  return t.length > 48 ? t.slice(0, 48) + '…' : (t || 'New chat');
}

function displayTitle(s) {
  if (s.titleLocked && (s.titleUser || '').trim()) return (s.titleUser || '').trim();
  if (s.titleLocked && (s.title || '').trim()) return (s.title || '').trim();
  return (s.title || '').trim() || autoTitleFromMessages(s.messages);
}

function normalizeSession(s) {
  const messages = Array.isArray(s.messages) ? s.messages : [];
  return {
    id: s.id,
    messages,
    mode: s.mode || 'auto',
    updated: typeof s.updated === 'number' ? s.updated : Date.now(),
    titleLocked: !!s.titleLocked,
    titleUser: typeof s.titleUser === 'string' ? s.titleUser : '',
    title: s.titleLocked
      ? ((s.titleUser || s.title || '').trim() || 'New chat')
      : (autoTitleFromMessages(messages) || (s.title || 'New chat')),
    preview: s.preview || sessionPreviewFromMessages(messages),
  };
}

async function persistSessionsToDisk() {
  const envelope = { v: 2, sessions, savedAt: Date.now() };
  const raw = JSON.stringify(envelope);
  const tryLocalStorage = () => {
    localStorage.setItem(LS_SESSIONS, raw);
    localStorage.removeItem(LS_SESSIONS_LARGE);
  };
  try {
    tryLocalStorage();
    if (localStorage.getItem(LS_SESSIONS_LARGE) === '1') await idbDelete(IDB_SESSIONS_KEY);
  } catch (e) {
    if (e?.name === 'QuotaExceededError' && window.indexedDB) {
      try {
        await idbSet(IDB_SESSIONS_KEY, raw);
        localStorage.setItem(LS_SESSIONS_LARGE, '1');
        const light = JSON.stringify({
          v: 2,
          skeleton: true,
          sessions: sessions.map(s => ({
            id: s.id,
            mode: s.mode,
            updated: s.updated,
            title: s.title,
            titleLocked: s.titleLocked,
            titleUser: s.titleUser,
            preview: s.preview,
            messages: [],
          })),
          savedAt: Date.now(),
        });
        localStorage.setItem(LS_SESSIONS, light);
      } catch (e2) {
        console.warn('Session persist failed', e2);
      }
    } else {
      console.warn('Session persist failed', e);
    }
  }
  if (currentSessionId) localStorage.setItem('cc_current_session', currentSessionId);
  else localStorage.removeItem('cc_current_session');
}

async function readSessionsStorage() {
  let raw = null;
  if (localStorage.getItem(LS_SESSIONS_LARGE) === '1' && window.indexedDB) {
    try { raw = await idbGet(IDB_SESSIONS_KEY); } catch { /* ignore */ }
  }
  if (!raw) {
    try { raw = localStorage.getItem(LS_SESSIONS); } catch { raw = null; }
  }
  if (!raw) { sessions = []; return; }
  let data;
  try { data = JSON.parse(raw); } catch { sessions = []; return; }
  let list = [];
  if (Array.isArray(data)) list = data;
  else if (data?.skeleton && localStorage.getItem(LS_SESSIONS_LARGE) === '1' && window.indexedDB) {
    try {
      const full = await idbGet(IDB_SESSIONS_KEY);
      if (full) {
        const inner = JSON.parse(full);
        list = inner.sessions || [];
      }
    } catch { list = []; }
  } else if (Array.isArray(data.sessions)) list = data.sessions;
  sessions = list.map(normalizeSession);
}

/** Static welcome trust highlights (mirrors index.html welcome block). */
function trustBarHtml() {
  return `<section class="trust-bar" aria-label="Trust and privacy highlights">
  <div class="trust-bar-inner">
    <div class="trust-card"><span class="trust-icon" aria-hidden="true">🔓</span><span class="trust-label">100% Open Source</span></div>
    <div class="trust-card"><span class="trust-icon" aria-hidden="true">🏠</span><span class="trust-label">Private by default (local-first)</span></div>
    <div class="trust-card"><span class="trust-icon" aria-hidden="true">☁️</span><span class="trust-label">Free cloud fallback</span></div>
    <div class="trust-card"><span class="trust-icon" aria-hidden="true">🤖</span><span class="trust-label">Agent mode + tools + memory</span></div>
    <div class="trust-card"><span class="trust-icon" aria-hidden="true">🛡️</span><span class="trust-label">No data stored</span></div>
  </div>
</section>`;
}

// ── Init ───────────────────────────────────────────────────────────────────
const PROVIDERS_CACHE_KEY = 'cc_providers_cache';

function loadCachedProviders() {
  try {
    const raw = localStorage.getItem(PROVIDERS_CACHE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return o && typeof o === 'object' && o.providers ? o.providers : o;
  } catch {
    return null;
  }
}

function saveProvidersCache(data) {
  try {
    localStorage.setItem(PROVIDERS_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), providers: data }));
  } catch { /* quota */ }
}

async function init() {
  loadSettings();
  await loadSessions();
  try {
    const res = await fetch(`${API}/api/providers`);
    if (res.ok) {
      providers = await res.json();
      saveProvidersCache(providers);
      buildProviderUI();
      restoreProvider();
      updateStatus();
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (e) {
    const cached = loadCachedProviders();
    if (cached && typeof cached === 'object' && Object.keys(cached).length) {
      providers = cached;
      buildProviderUI();
      restoreProvider();
      setStatus('warning', 'Offline — cached model list');
    } else {
      providers = {};
      setStatus('error', 'Cannot reach server');
    }
  }
  renderHistoryList();
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
      if (isMobileNavLayout()) {
        applyHistoryRailCollapsed(true);
        showSheetBackdrop();
        syncBottomNavState();
      }
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

function isMobileNavLayout() {
  return window.matchMedia('(max-width: 640px)').matches;
}

function showSheetBackdrop() {
  if (sheetBackdrop) sheetBackdrop.hidden = false;
}

function hideSheetBackdrop() {
  if (sheetBackdrop) sheetBackdrop.hidden = true;
}

function syncBottomNavState() {
  if (!bottomNavChat) return;
  if (!isMobileNavLayout()) {
    [bottomNavChat, bottomNavHistory, bottomNavSettings].forEach(b => b?.removeAttribute('aria-current'));
    return;
  }
  const settingsOpen = sidebar.classList.contains('open');
  const historyOpen = historyRail && !historyRail.classList.contains('collapsed');
  bottomNavChat.removeAttribute('aria-current');
  bottomNavHistory.removeAttribute('aria-current');
  bottomNavSettings.removeAttribute('aria-current');
  if (settingsOpen) bottomNavSettings.setAttribute('aria-current', 'page');
  else if (historyOpen) bottomNavHistory.setAttribute('aria-current', 'page');
  else bottomNavChat.setAttribute('aria-current', 'page');
}

function closeMobilePanels() {
  sidebar.classList.remove('open');
  sidebar.classList.add('collapsed');
  applyHistoryRailCollapsed(true);
  hideSheetBackdrop();
  syncBottomNavState();
}

function deleteSessionById(id) {
  sessions = sessions.filter(s => s.id !== id);
  void persistSessionsToDisk();
  if (id === currentSessionId) {
    currentSessionId = null;
    messages = [];
    localStorage.removeItem('cc_current_session');
    showWelcome();
  }
  renderHistoryList();
  syncBottomNavState();
}

sidebarToggle.addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
  sidebar.classList.toggle('open');
  if (isMobileNavLayout()) {
    if (sidebar.classList.contains('open')) {
      applyHistoryRailCollapsed(true);
      showSheetBackdrop();
    } else if (!historyRail?.classList.contains('collapsed')) {
      showSheetBackdrop();
    } else {
      hideSheetBackdrop();
    }
    syncBottomNavState();
  }
});

document.getElementById('sidebarClose')?.addEventListener('click', () => {
  sidebar.classList.remove('open');
  sidebar.classList.add('collapsed');
  if (isMobileNavLayout()) {
    if (!historyRail?.classList.contains('collapsed')) showSheetBackdrop();
    else hideSheetBackdrop();
    syncBottomNavState();
  }
});

sheetBackdrop?.addEventListener('click', () => {
  if (!isMobileNavLayout()) return;
  closeMobilePanels();
});

bottomNavChat?.addEventListener('click', () => {
  if (!isMobileNavLayout()) return;
  closeMobilePanels();
  userInput?.focus();
});

bottomNavHistory?.addEventListener('click', () => {
  if (!isMobileNavLayout()) return;
  sidebar.classList.remove('open');
  sidebar.classList.add('collapsed');
  applyHistoryRailCollapsed(false);
  showSheetBackdrop();
  syncBottomNavState();
  historySearchInput?.focus();
});

bottomNavSettings?.addEventListener('click', () => {
  if (!isMobileNavLayout()) return;
  applyHistoryRailCollapsed(true);
  sidebar.classList.remove('collapsed');
  sidebar.classList.add('open');
  showSheetBackdrop();
  syncBottomNavState();
});

window.addEventListener('resize', () => {
  if (!isMobileNavLayout()) {
    hideSheetBackdrop();
    syncBottomNavState();
  }
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

// ── PWA: register service worker (HTTPS or localhost) ─────────────────────
if ('serviceWorker' in navigator) {
  const { protocol, hostname } = location;
  const allowSw = protocol === 'https:' || hostname === 'localhost' || hostname === '127.0.0.1';
  if (allowSw) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
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
      ${trustBarHtml()}
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
      if (isMobileNavLayout()) {
        applyHistoryRailCollapsed(true);
        showSheetBackdrop();
        syncBottomNavState();
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
async function loadSessions() {
  await readSessionsStorage();
  currentSessionId = localStorage.getItem('cc_current_session') || null;
  if (currentSessionId) {
    const s = sessions.find(x => x.id === currentSessionId);
    if (s) {
      messages = [...(s.messages || [])];
      chatMode = s.mode || 'auto';
      if (messages.length) replayMessages();
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
}

function newSession() {
  messages = [];
  currentSessionId = null;
  localStorage.removeItem('cc_current_session');
  showWelcome();
  renderHistoryList();
  syncBottomNavState();
}

function saveCurrentSession() {
  const now = Date.now();
  if (messages.length === 0) {
    if (!currentSessionId) return;
    const s = sessions.find(x => x.id === currentSessionId);
    if (s) {
      s.messages = [];
      s.updated = now;
      s.preview = '';
      if (!s.titleLocked) s.title = 'New chat';
      sessions.sort((a, b) => b.updated - a.updated);
      void persistSessionsToDisk();
      renderHistoryList();
    }
    return;
  }
  const preview = sessionPreviewFromMessages(messages);
  if (!currentSessionId) {
    currentSessionId = 's_' + now;
    sessions.unshift(normalizeSession({
      id: currentSessionId,
      messages: [...messages],
      mode: chatMode,
      updated: now,
      titleLocked: false,
      titleUser: '',
      title: autoTitleFromMessages(messages),
      preview,
    }));
  } else {
    const s = sessions.find(x => x.id === currentSessionId);
    if (s) {
      s.messages = [...messages];
      s.mode = chatMode;
      s.updated = now;
      s.preview = preview;
      if (!s.titleLocked) s.title = autoTitleFromMessages(messages);
    } else {
      sessions.unshift(normalizeSession({
        id: currentSessionId,
        messages: [...messages],
        mode: chatMode,
        updated: now,
        titleLocked: false,
        titleUser: '',
        title: autoTitleFromMessages(messages),
        preview,
      }));
    }
  }
  sessions.sort((a, b) => b.updated - a.updated);
  sessions = sessions.slice(0, 200);
  void persistSessionsToDisk();
  renderHistoryList();
}

function sessionTitle(msgs) {
  return autoTitleFromMessages(msgs);
}

function formatSessionWhen(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined });
}

function filteredSessionsForHistory() {
  const q = historySearchQuery.trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter(s => {
    const hay = [
      displayTitle(s),
      s.preview || '',
      ...(s.messages || []).map(m => stripForPreview(m.content)),
    ].join(' ').toLowerCase();
    return hay.includes(q);
  });
}

function renderHistoryList() {
  if (!historyList) return;
  const list = filteredSessionsForHistory().sort((a, b) => b.updated - a.updated);
  if (list.length === 0) {
    historyList.innerHTML = `<li class="empty">${historySearchQuery.trim() ? 'No matches' : 'No conversations yet'}</li>`;
    return;
  }
  historyList.innerHTML = list.map(s => {
    const title = displayTitle(s);
    const prev = (s.preview || '').trim() || 'No messages yet';
    const when = formatSessionWhen(s.updated);
    return `<li class="history-item${s.id === currentSessionId ? ' active' : ''}" data-id="${escapeAttr(s.id)}" role="button" tabindex="0">
      <div class="history-item-track">
        <div class="history-item-surface">
          <div class="history-item-actions">
            <button type="button" class="history-item-del" data-del="${escapeAttr(s.id)}" title="Delete thread" aria-label="Delete">×</button>
          </div>
          <div class="history-item-title" data-title="${escapeAttr(s.id)}" title="Double-click to rename">${escapeHtml(title)}</div>
          <div class="history-item-meta"><span>${escapeHtml(when)}</span></div>
          <div class="history-item-preview">${escapeHtml(prev)}</div>
        </div>
        <div class="history-item-delete-strip" aria-hidden="true"><span>Delete</span></div>
      </div>
    </li>`;
  }).join('');
}

function switchToSession(id) {
  const s = sessions.find(x => x.id === id);
  if (!s) return;
  currentSessionId = s.id;
  messages = [...(s.messages || [])];
  chatMode = s.mode || 'auto';
  setChatMode(chatMode);
  localStorage.setItem('cc_current_session', currentSessionId);
  if (messages.length) replayMessages();
  else showWelcome();
  renderHistoryList();
  if (isMobileNavLayout()) {
    applyHistoryRailCollapsed(true);
    if (!sidebar.classList.contains('open')) hideSheetBackdrop();
    syncBottomNavState();
  }
}

historyList?.addEventListener('click', e => {
  const del = e.target.closest('.history-item-del');
  if (del) {
    e.stopPropagation();
    deleteSessionById(del.dataset.del);
    return;
  }
  const li = e.target.closest('.history-item[data-id]');
  if (!li) return;
  switchToSession(li.dataset.id);
});

// Swipe left on history row to delete (touch / pointer)
(() => {
  let ptrId = null;
  let startX = 0;
  let startY = 0;
  let row = null;

  historyList?.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.buttons !== 1) return;
    const li = e.target.closest('.history-item[data-id]');
    if (!li || e.target.closest('.history-item-del') || e.target.closest('.history-item-title-input')) return;
    ptrId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    row = li;
    try { row.setPointerCapture(ptrId); } catch { /* ignore */ }
  });

  historyList?.addEventListener('pointermove', e => {
    if (e.pointerId !== ptrId || !row) return;
    const dx = e.clientX - startX;
    const dy = Math.abs(e.clientY - startY);
    if (dy > 24) return;
    if (dx < -12) row.classList.add('history-item--swiping');
  });

  historyList?.addEventListener('pointerup', e => {
    if (e.pointerId !== ptrId || !row) return;
    const dx = e.clientX - startX;
    const dy = Math.abs(e.clientY - startY);
    try { row.releasePointerCapture(ptrId); } catch { /* ignore */ }
    row.classList.remove('history-item--swiping');
    if (dy < 40 && dx < -72) deleteSessionById(row.dataset.id);
    ptrId = null;
    row = null;
  });

  historyList?.addEventListener('pointercancel', () => {
    if (row) row.classList.remove('history-item--swiping');
    ptrId = null;
    row = null;
  });
})();

historyList?.addEventListener('keydown', e => {
  const li = e.target.closest('.history-item[data-id]');
  if (!li) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    switchToSession(li.dataset.id);
  }
});

historyList?.addEventListener('dblclick', e => {
  const titleWrap = e.target.closest('.history-item-title');
  if (!titleWrap) return;
  const li = titleWrap.closest('.history-item[data-id]');
  if (!li) return;
  const id = li.dataset.id;
  const s = sessions.find(x => x.id === id);
  if (!s) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'history-item-title-input';
  input.value = s.titleLocked ? (s.titleUser || displayTitle(s)) : displayTitle(s);
  titleWrap.replaceWith(input);
  input.focus();
  input.select();

  const finish = commit => {
    if (commit) {
      const v = input.value.trim();
      if (v) {
        s.titleLocked = true;
        s.titleUser = v;
        s.title = v;
      } else {
        s.titleLocked = false;
        s.titleUser = '';
        s.title = autoTitleFromMessages(s.messages);
      }
    }
    void persistSessionsToDisk();
    renderHistoryList();
  };

  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
    if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
});

historySearchInput?.addEventListener('input', () => {
  historySearchQuery = historySearchInput.value;
  renderHistoryList();
});

function applyHistoryRailCollapsed(collapsed) {
  if (!historyRail || !historyRailToggle) return;
  historyRail.classList.toggle('collapsed', collapsed);
  historyRailToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  historyRailToggle.title = collapsed ? 'Expand history' : 'Collapse history';
}

(() => {
  try {
    if (localStorage.getItem('cc_history_rail_collapsed') === '1') applyHistoryRailCollapsed(true);
  } catch { /* ignore */ }
})();

historyRailToggle?.addEventListener('click', () => {
  const collapsed = !historyRail.classList.contains('collapsed');
  applyHistoryRailCollapsed(collapsed);
  try { localStorage.setItem('cc_history_rail_collapsed', collapsed ? '1' : '0'); } catch { /* ignore */ }
  if (isMobileNavLayout()) {
    if (!collapsed) {
      sidebar.classList.remove('open');
      sidebar.classList.add('collapsed');
      showSheetBackdrop();
    } else if (!sidebar.classList.contains('open')) {
      hideSheetBackdrop();
    }
    syncBottomNavState();
  }
});

headerNewChatBtn?.addEventListener('click', () => newSession());

exportAllJsonBtn?.addEventListener('click', () => exportAllChats('json'));
exportAllMdBtn?.addEventListener('click', () => exportAllChats('md'));

function exportAllChats(kind) {
  if (!sessions.length) return;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  if (kind === 'json') {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), sessions }, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `openclaw-chats-${stamp}.json`);
    return;
  }
  let md = `# OpenClaw — all chats\n\n*Exported ${new Date().toLocaleString()}*\n\n---\n\n`;
  for (const s of [...sessions].sort((a, b) => b.updated - a.updated)) {
    const t = displayTitle(s);
    md += `## ${t}\n\n_${formatSessionWhen(s.updated)} · ${s.messages?.length || 0} messages_\n\n`;
    for (const m of s.messages || []) {
      const who = m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Assistant' : m.role;
      md += `**${who}**\n\n${m.content}\n\n`;
    }
    md += '---\n\n';
  }
  downloadBlob(new Blob([md], { type: 'text/markdown' }), `openclaw-chats-${stamp}.md`);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportChat() {
  if (messages.length === 0) return;
  const s = currentSessionId ? sessions.find(x => x.id === currentSessionId) : null;
  const title = s ? displayTitle(s) : sessionTitle(messages);
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
  syncBottomNavState();
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
    saveProvidersCache(providers);
    if (changed) { buildProviderUI(); updateStatus(); }
  } catch { /* ignore */ }
}, 30_000);
