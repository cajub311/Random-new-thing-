/* ── CloudClaw frontend app ──────────────────────────────────────────── */

const API = '';  // same-origin; set to e.g. 'https://yourapp.onrender.com' if separate

// ── State ─────────────────────────────────────────────────────────────────
let providers = {};
let messages = [];       // {role, content}[]
let isLoading = false;
let pendingFileText = null;

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

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  loadSettings();
  try {
    const res = await fetch(`${API}/api/providers`);
    providers = await res.json();
    buildProviderUI();
    restoreProvider();
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
    card.className = 'provider-card';
    card.innerHTML = `<div class="card-name">${p.name}</div><div class="card-tag">FREE tier</div>`;
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
  if (saved && providers[saved]) providerSelect.value = saved;
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
  localStorage.setItem(`cc_key_${id}`, apiKeyInput.value.trim());
  updateStatus();
});

function updateStatus() {
  const id = providerSelect.value;
  const p = providers[id];
  if (!p) { setStatus('offline', 'No provider'); return; }
  const key = apiKeyInput.value.trim() || (p.configured ? '(server)' : '');
  if (key) {
    setStatus('online', `${p.name} ready`);
  } else {
    setStatus('offline', `Add ${p.name} key`);
  }
}

function setStatus(state, text) {
  statusDot.className = `status-dot ${state}`;
  statusText.textContent = text;
}

// ── UI controls ────────────────────────────────────────────────────────────
toggleKeyBtn.addEventListener('click', () => {
  apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
});

tempRange.addEventListener('input', () => tempVal.textContent = tempRange.value);

clearBtn.addEventListener('click', () => {
  messages = [];
  showWelcome();
});

newChatBtn.addEventListener('click', () => {
  messages = [];
  showWelcome();
});

sidebarToggle.addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
  sidebar.classList.toggle('open');
});

// ── Auto-resize textarea ───────────────────────────────────────────────────
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

// ── File attach ────────────────────────────────────────────────────────────
attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  pendingFileText = await file.text();
  userInput.placeholder = `📎 ${file.name} attached — type your question…`;
  fileInput.value = '';
});

// ── Send message ───────────────────────────────────────────────────────────
chatForm.addEventListener('submit', async e => {
  e.preventDefault();
  if (isLoading) return;
  let text = userInput.value.trim();
  if (!text && !pendingFileText) return;

  if (pendingFileText) {
    text = `${text}\n\n\`\`\`\n${pendingFileText}\n\`\`\``;
    pendingFileText = null;
    userInput.placeholder = 'Ask anything… (Shift+Enter for new line)';
  }

  const id = providerSelect.value;
  const p = providers[id];
  const apiKey = apiKeyInput.value.trim();
  if (!p) { alert('Please select a provider.'); return; }
  if (!apiKey && !p.configured) {
    alert(`Please enter your ${p.name} API key. You can get one free at:\n${p.signupUrl}`);
    return;
  }

  userInput.value = '';
  userInput.style.height = 'auto';

  removeWelcome();
  appendMessage('user', text);
  messages.push({ role: 'user', content: text });

  const typingId = appendTyping();
  setLoading(true);

  try {
    const payload = {
      provider: id,
      model: modelSelect.value,
      apiKey: apiKey || undefined,
      messages: [
        { role: 'system', content: systemPrompt.value || 'You are a helpful assistant.' },
        ...messages,
      ],
      temperature: parseFloat(tempRange.value),
    };

    const res = await fetch(`${API}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    removeTyping(typingId);

    if (!res.ok || data.error) {
      appendMessage('assistant', data.error || 'Unknown error', true);
    } else {
      appendMessage('assistant', data.reply);
      messages.push({ role: 'assistant', content: data.reply });
    }
  } catch (err) {
    removeTyping(typingId);
    appendMessage('assistant', `Network error: ${err.message}`, true);
  } finally {
    setLoading(false);
  }
});

// ── Render helpers ─────────────────────────────────────────────────────────
function removeWelcome() {
  const w = messagesEl.querySelector('.welcome');
  if (w) w.remove();
}

function showWelcome() {
  messagesEl.innerHTML = `
    <div class="welcome">
      <div class="welcome-icon">🐾</div>
      <h1>Welcome to CloudClaw</h1>
      <p>A free, open, cloud-hosted AI assistant powered by the best free AI providers.</p>
      <div class="provider-cards" id="providerCards"></div>
      <p class="tip">Select a provider in the sidebar, add your free API key, and start chatting!</p>
    </div>`;
  // Re-bind provider cards after rebuilding DOM
  const newCards = document.getElementById('providerCards');
  for (const [id, p] of Object.entries(providers)) {
    const card = document.createElement('div');
    card.className = 'provider-card';
    card.innerHTML = `<div class="card-name">${p.name}</div><div class="card-tag">FREE tier</div>`;
    card.addEventListener('click', () => { providerSelect.value = id; providerSelect.dispatchEvent(new Event('change')); });
    newCards.appendChild(card);
  }
}

function appendMessage(role, content, isError = false) {
  const div = document.createElement('div');
  div.className = `message ${role}`;
  const avatar = role === 'user' ? '🧑' : '🐾';
  const name   = role === 'user' ? 'You' : (providers[providerSelect.value]?.name || 'AI');
  div.innerHTML = `
    <div class="msg-meta"><span class="msg-avatar">${avatar}</span><strong>${name}</strong><span>${timestamp()}</span></div>
    <div class="msg-bubble${isError ? ' error-bubble' : ''}">${renderMarkdown(content)}</div>
    <div class="msg-actions">
      <button class="msg-action-btn copy-btn">Copy</button>
      ${role === 'assistant' ? '<button class="msg-action-btn retry-btn">Retry</button>' : ''}
    </div>`;

  // Add copy-code buttons to <pre> blocks
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

  // Copy message button
  div.querySelector('.copy-btn')?.addEventListener('click', () => {
    navigator.clipboard.writeText(content);
    div.querySelector('.copy-btn').textContent = 'Copied!';
    setTimeout(() => div.querySelector('.copy-btn') && (div.querySelector('.copy-btn').textContent = 'Copy'), 2000);
  });

  // Retry button
  div.querySelector('.retry-btn')?.addEventListener('click', () => {
    // Remove last assistant message, re-send
    messages.pop();
    div.remove();
    chatForm.dispatchEvent(new Event('submit'));
  });

  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function appendTyping() {
  const id = 'typing-' + Date.now();
  const div = document.createElement('div');
  div.className = 'message assistant';
  div.id = id;
  div.innerHTML = `
    <div class="msg-meta"><span class="msg-avatar">🐾</span><strong>${providers[providerSelect.value]?.name || 'AI'}</strong></div>
    <div class="msg-bubble"><div class="typing-bubble"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></div></div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return id;
}

function removeTyping(id) {
  document.getElementById(id)?.remove();
}

function setLoading(state) {
  isLoading = state;
  sendBtn.disabled = state;
  sendIcon.style.display = state ? 'none' : 'inline';
  loadingIcon.style.display = state ? 'inline' : 'none';
}

function timestamp() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Markdown renderer (no external deps) ──────────────────────────────────
function renderMarkdown(text) {
  // Escape HTML first
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Fenced code blocks
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) =>
    `<pre><code class="lang-${lang}">${code.trimEnd()}</code></pre>`);

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold / italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');

  // Blockquote
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // HR
  html = html.replace(/^---$/gm, '<hr>');

  // Unordered list
  html = html.replace(/(^[*\-] .+(\n[*\-] .+)*)/gm, block => {
    const items = block.split('\n').map(l => `<li>${l.replace(/^[*\-] /, '')}</li>`).join('');
    return `<ul>${items}</ul>`;
  });

  // Ordered list
  html = html.replace(/(^\d+\. .+(\n\d+\. .+)*)/gm, block => {
    const items = block.split('\n').map(l => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('');
    return `<ol>${items}</ol>`;
  });

  // Links
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Tables (simple)
  html = html.replace(/((\|.+\|\n)+)/g, block => {
    const rows = block.trim().split('\n').filter(r => !/^\|[-:| ]+\|$/.test(r));
    if (rows.length < 1) return block;
    const [head, ...body] = rows;
    const ths = head.split('|').filter(Boolean).map(c => `<th>${c.trim()}</th>`).join('');
    const trs = body.map(r => '<tr>' + r.split('|').filter(Boolean).map(c => `<td>${c.trim()}</td>`).join('') + '</tr>').join('');
    return `<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
  });

  // Paragraphs (double newline → <p>)
  html = html.replace(/\n\n+/g, '</p><p>');
  html = `<p>${html}</p>`;

  // Single newline → <br> inside <p>
  html = html.replace(/(?<!<\/?(p|h[1-6]|ul|ol|li|blockquote|pre|table|tr|td|th|hr)[^>]*>)\n(?!<\/?[a-z])/g, '<br>');

  // Clean up empty <p>
  html = html.replace(/<p>\s*<\/p>/g, '');

  return html;
}

// ── Persist settings ───────────────────────────────────────────────────────
function loadSettings() {
  const sys = localStorage.getItem('cc_system');
  if (sys) systemPrompt.value = sys;
  const temp = localStorage.getItem('cc_temp');
  if (temp) { tempRange.value = temp; tempVal.textContent = temp; }
}

systemPrompt.addEventListener('input', () => localStorage.setItem('cc_system', systemPrompt.value));
tempRange.addEventListener('input', () => localStorage.setItem('cc_temp', tempRange.value));

// ── Boot ───────────────────────────────────────────────────────────────────
init();
