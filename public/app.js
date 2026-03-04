/* ── CloudClaw frontend app ──────────────────────────────────────────── */

const API = '';  // same-origin; set full URL if backend is separate

// ── State ─────────────────────────────────────────────────────────────────
let providers  = {};
let messages   = [];        // {role, content}[] — conversation history
let isLoading  = false;
let chatMode   = 'auto';    // 'auto' | 'ask-all'
let pendingFileText = null;

// Provider priority for auto-fallback
const PROVIDER_ORDER = ['groq', 'grok', 'gemini', 'cohere', 'together', 'huggingface'];

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

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  loadSettings();
  try {
    const res = await fetch(`${API}/api/providers`);
    providers = await res.json();
    buildProviderUI();
    restoreProvider();
    updateStatus();
  } catch (e) {
    setStatus('error', 'Cannot reach server');
  }
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
    card.className = 'provider-card' + (p.configured ? ' configured' : '');
    card.innerHTML = `
      <div class="card-name">${p.name}</div>
      <div class="card-tag">${p.configured ? '✓ Connected' : 'FREE tier'}</div>`;
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
  // Auto-select the first provider that has a key available
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

  const savedKey = localStorage.getItem(`cc_key_${id}`) || '';
  apiKeyInput.value = savedKey;
  getKeyLink.href = p.signupUrl;
  getKeyLink.textContent = `Get free ${p.name} key →`;

  updateStatus();
  localStorage.setItem('cc_provider', id);
});

apiKeyInput.addEventListener('input', () => {
  const id = providerSelect.value;
  const trimmed = apiKeyInput.value.trim();
  if (trimmed) {
    localStorage.setItem(`cc_key_${id}`, trimmed);
  } else {
    localStorage.removeItem(`cc_key_${id}`);
  }
  updateStatus();
});

// ── Mode toggle ────────────────────────────────────────────────────────────
modeToggle.addEventListener('click', e => {
  const btn = e.target.closest('.mode-btn');
  if (!btn) return;
  chatMode = btn.dataset.mode;
  modeToggle.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b === btn));
  modeHint.textContent = chatMode === 'auto'
    ? 'Tries providers in order, auto-fallback on failure'
    : 'Sends to all configured providers simultaneously';
  updateStatus();
  localStorage.setItem('cc_mode', chatMode);
});

// ── Available providers helper ─────────────────────────────────────────────
function getAvailableProviders() {
  // Returns [{id, key}] in priority order for providers that have a key available
  const preferred = providerSelect.value;
  const ordered = [preferred, ...PROVIDER_ORDER.filter(id => id !== preferred)];
  return ordered
    .filter(id => providers[id])
    .map(id => {
      const key = localStorage.getItem(`cc_key_${id}`) || '';
      const configured = providers[id].configured;  // set by server env var
      if (key || configured) return { id, key };
      return null;
    })
    .filter(Boolean);
}

// ── Status helpers ─────────────────────────────────────────────────────────
function updateStatus() {
  const available = getAvailableProviders();
  if (available.length === 0) {
    setStatus('offline', 'No keys configured');
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
    const extra = available.length > 1 ? ` +${available.length - 1} fallback${available.length > 2 ? 's' : ''}` : '';
    setStatus('online', `${name}${extra}`);
    activePill.textContent = name;
    activePill.className = 'provider-pill online';
  }
}

function setStatus(state, text) {
  statusDot.className = `status-dot ${state}`;
  statusText.textContent = text;
}

// ── Low-level API call ─────────────────────────────────────────────────────
async function callProvider(id, key, msgs) {
  const res = await fetch(`${API}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: id,
      model: (providerSelect.value === id) ? modelSelect.value : providers[id].defaultModel,
      apiKey: key || undefined,
      messages: [
        { role: 'system', content: systemPrompt.value || 'You are a helpful assistant.' },
        ...msgs,
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || 'Unknown error');
  return data; // {reply, provider, model}
}

// ── Auto mode: try providers in order, fallback on failure ─────────────────
async function sendAuto(msgs) {
  const available = getAvailableProviders();
  if (available.length === 0) {
    appendMessage('assistant', 'No API keys configured. Add at least one free key in the sidebar.', true);
    setLoading(false);
    return;
  }

  const typingId = appendTyping(providers[available[0].id].name);

  for (let i = 0; i < available.length; i++) {
    const { id, key } = available[i];
    const name = providers[id].name;
    if (i > 0) setStatus('warning', `Trying ${name}…`);
    try {
      const data = await callProvider(id, key, msgs);
      removeTyping(typingId);
      appendMessage('assistant', data.reply, false, id);
      messages.push({ role: 'assistant', content: data.reply });
      setStatus('online', `${name} responded`);
      activePill.textContent = name;
      activePill.className = 'provider-pill online';
      return;
    } catch (err) {
      if (i < available.length - 1) {
        setStatus('warning', `${name} failed — trying ${providers[available[i + 1].id].name}…`);
      }
    }
  }

  removeTyping(typingId);
  appendMessage('assistant', 'All providers failed. Please check your API keys.', true);
  setStatus('error', 'All providers failed');
}

// ── Ask All mode: fan out, show each response with badge ──────────────────
async function sendAskAll(msgs) {
  const available = getAvailableProviders();
  if (available.length === 0) {
    appendMessage('assistant', 'No API keys configured. Add at least one free key in the sidebar.', true);
    setLoading(false);
    return;
  }

  // One typing bubble per provider
  const slots = available.map(({ id }) => ({
    id,
    typingId: appendTyping(providers[id].name),
  }));

  await Promise.allSettled(available.map(async ({ id, key }, i) => {
    try {
      const data = await callProvider(id, key, msgs);
      removeTyping(slots[i].typingId);
      appendMessage('assistant', data.reply, false, id, true /* isAskAll */);
    } catch (err) {
      removeTyping(slots[i].typingId);
      appendMessage('assistant', `[${providers[id].name}] ${err.message}`, true, id, true);
    }
  }));

  // Ask All doesn't push to conversation history (it's compare mode)
  setStatus('online', `${available.length} providers answered`);
}

// ── Submit handler ─────────────────────────────────────────────────────────
chatForm.addEventListener('submit', async e => {
  e.preventDefault();
  if (isLoading) return;
  let text = userInput.value.trim();
  if (!text && !pendingFileText) return;

  if (pendingFileText) {
    text = text ? `${text}\n\n\`\`\`\n${pendingFileText}\n\`\`\`` : `\`\`\`\n${pendingFileText}\n\`\`\``;
    pendingFileText = null;
    userInput.placeholder = 'Ask anything… (Shift+Enter for new line)';
  }

  userInput.value = '';
  userInput.style.height = 'auto';
  removeWelcome();
  appendMessage('user', text);
  messages.push({ role: 'user', content: text });
  setLoading(true);

  if (chatMode === 'ask-all') {
    await sendAskAll([...messages]);
  } else {
    await sendAuto([...messages]);
  }

  setLoading(false);
});

// ── UI controls ────────────────────────────────────────────────────────────
toggleKeyBtn.addEventListener('click', () => {
  apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
});

tempRange.addEventListener('input', () => tempVal.textContent = tempRange.value);

clearBtn.addEventListener('click', () => { messages = []; showWelcome(); });
newChatBtn.addEventListener('click', () => { messages = []; showWelcome(); });

sidebarToggle.addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
  sidebar.classList.toggle('open');
});

userInput.addEventListener('input', () => {
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 200) + 'px';
});

userInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    chatForm.dispatchEvent(new Event('submit'));
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

// ── Render helpers ─────────────────────────────────────────────────────────
function removeWelcome() {
  messagesEl.querySelector('.welcome')?.remove();
}

function showWelcome() {
  messagesEl.innerHTML = `
    <div class="welcome">
      <div class="welcome-icon">🐾</div>
      <h1>Welcome to CloudClaw</h1>
      <p>Free, open AI — powered by the best no-cost API providers.</p>
      <div class="provider-cards" id="providerCardsWelcome"></div>
      <p class="tip">Add at least one free API key in the sidebar — CloudClaw auto-connects and falls back if needed.</p>
    </div>`;
  const cards = document.getElementById('providerCardsWelcome');
  for (const [id, p] of Object.entries(providers)) {
    const card = document.createElement('div');
    card.className = 'provider-card' + (getAvailableProviders().some(a => a.id === id) ? ' configured' : '');
    card.innerHTML = `<div class="card-name">${p.name}</div><div class="card-tag">${getAvailableProviders().some(a => a.id === id) ? '✓ Connected' : 'FREE tier'}</div>`;
    card.addEventListener('click', () => {
      providerSelect.value = id;
      providerSelect.dispatchEvent(new Event('change'));
      sidebar.classList.remove('collapsed');
      sidebar.classList.add('open');
    });
    cards.appendChild(card);
  }
}

function appendMessage(role, content, isError = false, providerId = null, isAskAll = false) {
  const div = document.createElement('div');
  div.className = `message ${role}${isAskAll ? ' ask-all-group' : ''}`;
  const avatar = role === 'user' ? '🧑' : '🐾';
  const name   = role === 'user' ? 'You' : (providerId ? providers[providerId]?.name : providers[providerSelect.value]?.name) || 'AI';
  div.innerHTML = `
    <div class="msg-meta">
      <span class="msg-avatar">${avatar}</span>
      <strong>${name}</strong>
      <span>${timestamp()}</span>
    </div>
    <div class="msg-bubble${isError ? ' error-bubble' : ''}">${renderMarkdown(content)}</div>
    <div class="msg-actions">
      <button class="msg-action-btn copy-btn">Copy</button>
      ${role === 'assistant' && !isAskAll ? '<button class="msg-action-btn retry-btn">Retry</button>' : ''}
    </div>`;

  div.querySelectorAll('pre').forEach(pre => {
    const btn = document.createElement('button');
    btn.className = 'copy-code-btn';
    btn.textContent = 'Copy';
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(pre.querySelector('code')?.textContent || pre.textContent);
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 2000);
    });
    pre.style.position = 'relative';
    pre.appendChild(btn);
  });

  div.querySelector('.copy-btn')?.addEventListener('click', () => {
    navigator.clipboard.writeText(content);
    const btn = div.querySelector('.copy-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => { if (btn) btn.textContent = 'Copy'; }, 2000);
  });

  div.querySelector('.retry-btn')?.addEventListener('click', () => {
    messages.pop();
    div.remove();
    chatForm.dispatchEvent(new Event('submit'));
  });

  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function appendTyping(providerName = 'AI') {
  const id = 'typing-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const div = document.createElement('div');
  div.className = 'message assistant';
  div.id = id;
  div.innerHTML = `
    <div class="msg-meta"><span class="msg-avatar">🐾</span><strong>${providerName}</strong></div>
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

function setLoading(state) {
  isLoading = state;
  sendBtn.disabled = state;
  sendIcon.style.display = state ? 'none' : 'inline';
  loadingIcon.style.display = state ? 'inline' : 'none';
}

function timestamp() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Markdown renderer ──────────────────────────────────────────────────────
function renderMarkdown(text) {
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) =>
    `<pre><code class="lang-${lang}">${code.trimEnd()}</code></pre>`);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/^---$/gm, '<hr>');
  html = html.replace(/(^[*\-] .+(\n[*\-] .+)*)/gm, block => {
    const items = block.split('\n').map(l => `<li>${l.replace(/^[*\-] /, '')}</li>`).join('');
    return `<ul>${items}</ul>`;
  });
  html = html.replace(/(^\d+\. .+(\n\d+\. .+)*)/gm, block => {
    const items = block.split('\n').map(l => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('');
    return `<ol>${items}</ol>`;
  });
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  html = html.replace(/((\|.+\|\n)+)/g, block => {
    const rows = block.trim().split('\n').filter(r => !/^\|[-:| ]+\|$/.test(r));
    if (rows.length < 1) return block;
    const [head, ...body] = rows;
    const ths = head.split('|').filter(Boolean).map(c => `<th>${c.trim()}</th>`).join('');
    const trs = body.map(r => '<tr>' + r.split('|').filter(Boolean).map(c => `<td>${c.trim()}</td>`).join('') + '</tr>').join('');
    return `<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
  });
  html = html.replace(/\n\n+/g, '</p><p>');
  html = `<p>${html}</p>`;
  html = html.replace(/(?<!<\/?(p|h[1-6]|ul|ol|li|blockquote|pre|table|tr|td|th|hr)[^>]*>)\n(?!<\/?[a-z])/g, '<br>');
  html = html.replace(/<p>\s*<\/p>/g, '');
  return html;
}

// ── Persist settings ───────────────────────────────────────────────────────
function loadSettings() {
  const sys = localStorage.getItem('cc_system');
  if (sys) systemPrompt.value = sys;
  const temp = localStorage.getItem('cc_temp');
  if (temp) { tempRange.value = temp; tempVal.textContent = temp; }
  const mode = localStorage.getItem('cc_mode');
  if (mode === 'ask-all') {
    chatMode = 'ask-all';
    modeToggle.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === 'ask-all'));
    modeHint.textContent = 'Sends to all configured providers simultaneously';
  }
}

systemPrompt.addEventListener('input', () => localStorage.setItem('cc_system', systemPrompt.value));
tempRange.addEventListener('input', () => localStorage.setItem('cc_temp', tempRange.value));

// ── Boot ───────────────────────────────────────────────────────────────────
init();
