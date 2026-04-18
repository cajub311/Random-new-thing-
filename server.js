import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join, resolve, basename } from 'path';
import { mkdir, writeFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(join(__dirname, 'public')));

// Writable workspace for agent-created files. On serverless platforms the
// bundle dir is read-only, so fall back to /tmp. Locally we use ./workspace.
const WORKSPACE_DIR = (() => {
  const preferred = process.env.WORKSPACE_DIR || join(__dirname, 'workspace');
  try {
    if (!existsSync(preferred)) {
      // On serverless (Vercel), __dirname is read-only.
      if (process.env.VERCEL === '1' || process.env.AWS_LAMBDA_FUNCTION_NAME) {
        return '/tmp/cloudclaw-workspace';
      }
    }
    return preferred;
  } catch {
    return '/tmp/cloudclaw-workspace';
  }
})();

async function ensureWorkspace() {
  if (!existsSync(WORKSPACE_DIR)) {
    await mkdir(WORKSPACE_DIR, { recursive: true });
  }
}

// ── Provider registry ──────────────────────────────────────────────────────
// IMPORTANT: Pollinations is the default because it requires **no API key**.
// All other providers are kept as optional upgrades for users who want them.
const PROVIDERS = {
  pollinations: {
    name: 'Pollinations (no key needed)',
    url: 'https://text.pollinations.ai/openai',
    envKey: null,                 // no key required
    models: ['openai', 'openai-fast', 'openai-large', 'mistral', 'llama', 'gemini'],
    defaultModel: 'openai',
    free: true,
    keyless: true,
    signupUrl: 'https://pollinations.ai',
    format: 'openai',
    supportsTools: true,
  },
  groq: {
    name: 'Groq (Llama 3)',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    envKey: 'GROQ_API_KEY',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768', 'gemma2-9b-it'],
    defaultModel: 'llama-3.3-70b-versatile',
    free: true,
    signupUrl: 'https://console.groq.com',
    format: 'openai',
    supportsTools: true,
  },
  gemini: {
    name: 'Google Gemini',
    url: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
    envKey: 'GEMINI_API_KEY',
    models: ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'],
    defaultModel: 'gemini-2.0-flash',
    free: true,
    signupUrl: 'https://aistudio.google.com',
    format: 'gemini',
    supportsTools: false,
  },
  cohere: {
    name: 'Cohere',
    url: 'https://api.cohere.com/v1/chat',
    envKey: 'COHERE_API_KEY',
    models: ['command-r-plus', 'command-r', 'command'],
    defaultModel: 'command-r-plus',
    free: true,
    signupUrl: 'https://dashboard.cohere.com',
    format: 'cohere',
    supportsTools: false,
  },
  together: {
    name: 'Together AI',
    url: 'https://api.together.xyz/v1/chat/completions',
    envKey: 'TOGETHER_API_KEY',
    models: ['meta-llama/Llama-3-70b-chat-hf', 'mistralai/Mixtral-8x7B-Instruct-v0.1', 'Qwen/Qwen2.5-72B-Instruct-Turbo'],
    defaultModel: 'meta-llama/Llama-3-70b-chat-hf',
    free: true,
    signupUrl: 'https://api.together.xyz',
    format: 'openai',
    supportsTools: true,
  },
  huggingface: {
    name: 'Hugging Face',
    url: 'https://api-inference.huggingface.co/models/{model}',
    envKey: 'HF_API_KEY',
    models: ['mistralai/Mistral-7B-Instruct-v0.3', 'HuggingFaceH4/zephyr-7b-beta'],
    defaultModel: 'mistralai/Mistral-7B-Instruct-v0.3',
    free: true,
    signupUrl: 'https://huggingface.co/settings/tokens',
    format: 'huggingface',
    supportsTools: false,
  },
};

// ── Helper: call OpenAI-compatible API ────────────────────────────────────
async function callOpenAI(provider, messages, model, apiKey, { tools } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const body = {
    model: model || provider.defaultModel,
    messages,
    stream: false,
    max_tokens: 4096,
  };
  if (tools && tools.length) body.tools = tools;
  const res = await fetch(provider.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${provider.name} error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error(`${provider.name} returned no message`);
  return msg;  // {role, content, tool_calls?}
}

// ── Helper: call Gemini API ───────────────────────────────────────────────
async function callGemini(provider, messages, model, apiKey) {
  const m = model || provider.defaultModel;
  const url = `${provider.url.replace('{model}', m)}?key=${apiKey}`;
  const contents = messages
    .filter(msg => msg.role !== 'system')
    .map(msg => ({ role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text: msg.content }] }));
  const systemMsg = messages.find(msg => msg.role === 'system');
  const body = { contents };
  if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg.content }] };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { role: 'assistant', content: data.candidates[0].content.parts[0].text };
}

// ── Helper: call Cohere API ───────────────────────────────────────────────
async function callCohere(provider, messages, model, apiKey) {
  const systemMsg = messages.find(m => m.role === 'system')?.content || '';
  const history = messages.filter(m => m.role !== 'system').slice(0, -1).map(m => ({
    role: m.role === 'assistant' ? 'CHATBOT' : 'USER',
    message: m.content,
  }));
  const lastMsg = messages.filter(m => m.role !== 'system').slice(-1)[0];
  const res = await fetch(provider.url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || provider.defaultModel,
      message: lastMsg.content,
      chat_history: history,
      preamble: systemMsg,
      max_tokens: 4096,
    }),
  });
  if (!res.ok) throw new Error(`Cohere error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { role: 'assistant', content: data.text };
}

// ── Helper: call Hugging Face Inference API ───────────────────────────────
async function callHuggingFace(provider, messages, model, apiKey) {
  const m = model || provider.defaultModel;
  const url = provider.url.replace('{model}', m);
  const prompt = messages.map(msg => {
    if (msg.role === 'system') return `<s>[INST] <<SYS>>\n${msg.content}\n<</SYS>>\n\n`;
    if (msg.role === 'user') return `${msg.content} [/INST]`;
    return `${msg.content} </s><s>[INST] `;
  }).join('');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: prompt, parameters: { max_new_tokens: 1024, return_full_text: false } }),
  });
  if (!res.ok) throw new Error(`HuggingFace error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const content = Array.isArray(data) ? data[0]?.generated_text : data.generated_text;
  return { role: 'assistant', content };
}

// Dispatch to the right provider and normalize to an OpenAI-style message.
async function chatCompletion(provider, messages, model, apiKey, opts = {}) {
  if (provider.format === 'openai')      return callOpenAI(provider, messages, model, apiKey, opts);
  if (provider.format === 'gemini')      return callGemini(provider, messages, model, apiKey);
  if (provider.format === 'cohere')      return callCohere(provider, messages, model, apiKey);
  if (provider.format === 'huggingface') return callHuggingFace(provider, messages, model, apiKey);
  throw new Error(`Unknown format: ${provider.format}`);
}

// ── Agent tools ────────────────────────────────────────────────────────────
const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the public web (DuckDuckGo) for up-to-date information. Returns a list of results with title, snippet, and URL.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
          limit: { type: 'integer', description: 'Max number of results (default 5, max 10)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Generate an image from a text prompt using a free keyless service (Pollinations). Returns a URL pointing at the image and saves a reference in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Detailed description of the image to generate' },
          width:  { type: 'integer', description: 'Width in pixels (default 768)' },
          height: { type: 'integer', description: 'Height in pixels (default 768)' },
          seed:   { type: 'integer', description: 'Optional random seed for reproducibility' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate',
      description: 'Evaluate a math expression and return the numeric result. Use for any numeric computation to avoid arithmetic mistakes. Supports +, -, *, /, %, **, parentheses, and standard Math.* functions (sqrt, sin, cos, log, etc).',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'The math expression, e.g. "sqrt(2)*3 + 5**2"' },
        },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch a public web page and return its text content (HTML tags stripped). Use to read a page from a web_search result.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch (http or https)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_file',
      description: 'Create a text file in the user\'s workspace. Returns a download URL the user can click to retrieve the file.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'File name, e.g. "report.md" or "notes.txt". No slashes.' },
          content:  { type: 'string', description: 'Full text content to write.' },
        },
        required: ['filename', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draft_email',
      description: 'Draft an email. Produces a mailto: link the user can click to open their email client with the draft pre-filled.',
      parameters: {
        type: 'object',
        properties: {
          to:      { type: 'string', description: 'Recipient email address' },
          subject: { type: 'string', description: 'Email subject line' },
          body:    { type: 'string', description: 'Full email body in plain text' },
          cc:      { type: 'string', description: 'Optional CC address(es), comma-separated' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'current_time',
      description: 'Return the current UTC date and time. Use when the user asks about "now", "today", or time-sensitive information.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function toolWebSearch({ query, limit = 5 }) {
  const cap = Math.min(Math.max(1, limit | 0), 10);
  // DuckDuckGo Instant Answer (no key). We also scrape the HTML endpoint for
  // organic results since the instant-answer API is sparse.
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 CloudClaw/1.0' } });
  if (!res.ok) throw new Error(`web_search failed: ${res.status}`);
  const html = await res.text();
  const results = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && results.length < cap) {
    let link = m[1];
    // DuckDuckGo wraps links in /l/?uddg=...
    try {
      const u = new URL(link, 'https://duckduckgo.com');
      const real = u.searchParams.get('uddg');
      if (real) link = decodeURIComponent(real);
    } catch { /* keep original */ }
    results.push({
      title:   stripHtml(m[2]),
      url:     link,
      snippet: stripHtml(m[3]),
    });
  }
  return { query, results };
}

async function toolFetchUrl({ url }) {
  if (!/^https?:\/\//i.test(url)) throw new Error('fetch_url requires an http(s) URL');
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 CloudClaw/1.0' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`fetch_url: HTTP ${res.status}`);
  const ctype = res.headers.get('content-type') || '';
  const raw = await res.text();
  const text = ctype.includes('html') ? stripHtml(raw) : raw;
  const trimmed = text.length > 8000 ? text.slice(0, 8000) + '\n\n…[truncated]' : text;
  return { url, content_type: ctype, length: text.length, text: trimmed };
}

async function toolCreateFile({ filename, content }) {
  await ensureWorkspace();
  const safe = basename(filename).replace(/[^\w.\-]/g, '_').slice(0, 120) || 'file.txt';
  const outPath = join(WORKSPACE_DIR, safe);
  await writeFile(outPath, String(content ?? ''), 'utf8');
  return {
    filename: safe,
    bytes: Buffer.byteLength(String(content ?? ''), 'utf8'),
    download_url: `/api/files/${encodeURIComponent(safe)}`,
    note: 'File created. The user can click the download URL to retrieve it.',
  };
}

function toolDraftEmail({ to, subject, body, cc }) {
  const params = new URLSearchParams();
  params.set('subject', subject);
  params.set('body', body);
  if (cc) params.set('cc', cc);
  const mailto = `mailto:${encodeURIComponent(to)}?${params.toString().replace(/\+/g, '%20')}`;
  return {
    to, cc: cc || null, subject, body,
    mailto_link: mailto,
    note: 'Click the mailto_link to open this draft in your email client and send.',
  };
}

function toolCurrentTime() {
  const now = new Date();
  return {
    iso: now.toISOString(),
    utc: now.toUTCString(),
    unix: Math.floor(now.getTime() / 1000),
  };
}

async function toolGenerateImage({ prompt, width = 768, height = 768, seed }) {
  const w = Math.min(Math.max(64, width | 0), 2048);
  const h = Math.min(Math.max(64, height | 0), 2048);
  const params = new URLSearchParams({ width: String(w), height: String(h), nologo: 'true' });
  if (Number.isInteger(seed)) params.set('seed', String(seed));
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params}`;
  return {
    prompt,
    width: w,
    height: h,
    seed: Number.isInteger(seed) ? seed : null,
    image_url: url,
    note: 'Image URL is a live service — opens directly in any browser or <img> tag.',
  };
}

// Safe-ish math evaluator. We allow a tight whitelist of characters and then
// expose just the Math object via Function. Anything that tries to access a
// global or an identifier other than "Math" is rejected.
function toolCalculate({ expression }) {
  const expr = String(expression || '').trim();
  if (!expr) return { error: 'empty expression' };
  if (expr.length > 200) return { error: 'expression too long' };
  if (!/^[-+*/%^().,0-9a-zA-Z_\s]+$/.test(expr)) {
    return { error: 'only numbers, operators, parentheses, and identifiers allowed' };
  }
  // Reject any identifier that is not a Math member.
  const ids = expr.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) || [];
  const allowed = new Set(['Math', ...Object.getOwnPropertyNames(Math), 'e', 'pi']);
  for (const id of ids) {
    if (!allowed.has(id)) return { error: `disallowed identifier: ${id}` };
  }
  try {
    const normalized = expr
      .replace(/\^/g, '**')
      .replace(/\bpi\b/g, 'Math.PI')
      .replace(/\be\b/g, 'Math.E')
      .replace(/\b(sqrt|cbrt|sin|cos|tan|asin|acos|atan|atan2|exp|log|log2|log10|pow|abs|round|floor|ceil|trunc|sign|min|max|hypot)\(/g, 'Math.$1(');
    // eslint-disable-next-line no-new-func
    const fn = new Function(`"use strict"; return (${normalized});`);
    const value = fn();
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { error: 'non-numeric or non-finite result' };
    }
    return { expression: expr, result: value };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

const TOOL_IMPLS = {
  web_search:     toolWebSearch,
  fetch_url:      toolFetchUrl,
  create_file:    toolCreateFile,
  draft_email:    toolDraftEmail,
  current_time:   toolCurrentTime,
  generate_image: toolGenerateImage,
  calculate:      toolCalculate,
};

async function runTool(name, argsJson) {
  const impl = TOOL_IMPLS[name];
  if (!impl) return { error: `Unknown tool: ${name}` };
  let args = {};
  try { args = argsJson ? JSON.parse(argsJson) : {}; }
  catch (e) { return { error: `Invalid JSON arguments: ${e.message}` }; }
  try {
    const out = await impl(args);
    return out;
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// ── Route: GET /api/providers ─────────────────────────────────────────────
app.get('/api/providers', (req, res) => {
  const result = {};
  for (const [id, p] of Object.entries(PROVIDERS)) {
    result[id] = {
      name: p.name,
      models: p.models,
      defaultModel: p.defaultModel,
      free: p.free,
      keyless: !!p.keyless,
      signupUrl: p.signupUrl,
      configured: p.keyless || !!(p.envKey && process.env[p.envKey]),
      supportsTools: !!p.supportsTools,
    };
  }
  res.json(result);
});

// ── Route: POST /api/chat/stream ──────────────────────────────────────────
// Server-Sent Events endpoint. Streams plain text deltas to the client for a
// natural typing effect. Only works for OpenAI-compatible providers.
app.post('/api/chat/stream', async (req, res) => {
  const { provider: providerId = 'pollinations', model, messages, apiKey } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  const provider = PROVIDERS[providerId];
  if (!provider) return res.status(400).json({ error: `Unknown provider: ${providerId}` });

  const key = provider.keyless ? null : (apiKey || (provider.envKey && process.env[provider.envKey]));
  if (!provider.keyless && !key) {
    return res.status(400).json({ error: `No API key for ${provider.name}.` });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Gemini/Cohere/HF don't have OpenAI-compatible streaming here — fall back to
  // a single-shot call and emit the whole reply in one "delta" event.
  if (provider.format !== 'openai') {
    try {
      const msg = await chatCompletion(provider, messages, model, key);
      send('delta', { content: msg.content || '' });
      send('done', { provider: provider.name, model: model || provider.defaultModel });
    } catch (err) {
      send('error', { message: err.message });
    }
    return res.end();
  }

  const upstream = await fetch(provider.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model: model || provider.defaultModel,
      messages,
      stream: true,
      max_tokens: 4096,
    }),
  }).catch(e => ({ ok: false, error: e }));

  if (!upstream || !upstream.ok || !upstream.body) {
    const msg = upstream?.error?.message || `upstream status ${upstream?.status}`;
    send('error', { message: msg });
    return res.end();
  }

  // Relay OpenAI-style SSE as simple `delta` events with just the text.
  const decoder = new TextDecoder();
  let buf = '';
  let closed = false;

  req.on('close', () => { closed = true; try { upstream.body.cancel?.(); } catch {} });

  try {
    for await (const chunk of upstream.body) {
      if (closed) break;
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 2);
        if (!raw) continue;
        // Each event block may have multiple "data:" lines.
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') { send('done', { provider: provider.name, model: model || provider.defaultModel }); return res.end(); }
          try {
            const obj = JSON.parse(payload);
            const delta = obj.choices?.[0]?.delta?.content;
            if (delta) send('delta', { content: delta });
          } catch { /* ignore malformed chunk */ }
        }
      }
    }
    send('done', { provider: provider.name, model: model || provider.defaultModel });
  } catch (err) {
    send('error', { message: err.message });
  }
  res.end();
});

// ── Route: POST /api/chat ─────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { provider: providerId = 'pollinations', model, messages, apiKey } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const provider = PROVIDERS[providerId];
  if (!provider) return res.status(400).json({ error: `Unknown provider: ${providerId}` });

  const key = provider.keyless ? null : (apiKey || (provider.envKey && process.env[provider.envKey]));
  if (!provider.keyless && !key) {
    return res.status(400).json({
      error: `No API key for ${provider.name}. Set ${provider.envKey} env var or enter it in the sidebar. Get a free key at ${provider.signupUrl}`,
    });
  }

  try {
    const msg = await chatCompletion(provider, messages, model, key);
    res.json({ reply: msg.content, provider: provider.name, model: model || provider.defaultModel });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Route: POST /api/agent ────────────────────────────────────────────────
// Runs a tool-calling loop: model picks tools → we execute → feed results back
// until the model stops calling tools. Returns the final reply plus a trace.
app.post('/api/agent', async (req, res) => {
  const { provider: providerId = 'pollinations', model, messages, apiKey, maxSteps = 6 } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const provider = PROVIDERS[providerId];
  if (!provider) return res.status(400).json({ error: `Unknown provider: ${providerId}` });
  if (!provider.supportsTools) {
    return res.status(400).json({ error: `${provider.name} does not support tool calling. Use Pollinations, Groq, or Together.` });
  }

  const key = provider.keyless ? null : (apiKey || (provider.envKey && process.env[provider.envKey]));
  if (!provider.keyless && !key) {
    return res.status(400).json({
      error: `No API key for ${provider.name}. Use Pollinations for zero-key agent mode, or set ${provider.envKey}.`,
    });
  }

  const trace = [];
  const convo = [...messages];
  const steps = Math.min(Math.max(1, maxSteps | 0), 10);

  try {
    for (let step = 0; step < steps; step++) {
      const msg = await chatCompletion(provider, convo, model, key, { tools: TOOL_DEFS });

      const toolCalls = msg.tool_calls || [];
      // Append the assistant message (including tool_calls) to the conversation.
      const assistantEntry = { role: 'assistant', content: msg.content || '' };
      if (toolCalls.length) assistantEntry.tool_calls = toolCalls;
      convo.push(assistantEntry);

      if (!toolCalls.length) {
        return res.json({
          reply: msg.content || '',
          provider: provider.name,
          model: model || provider.defaultModel,
          steps: step + 1,
          trace,
        });
      }

      // Execute each tool and feed the result back.
      for (const tc of toolCalls) {
        const fname = tc.function?.name;
        const fargs = tc.function?.arguments || '{}';
        const result = await runTool(fname, fargs);
        trace.push({ step: step + 1, tool: fname, args: safeParse(fargs), result });
        convo.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: fname,
          content: JSON.stringify(result).slice(0, 16000),
        });
      }
    }

    return res.json({
      reply: 'Reached the max tool-call step limit before finishing. Try asking a simpler question or raising maxSteps.',
      provider: provider.name,
      model: model || provider.defaultModel,
      steps,
      trace,
      truncated: true,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message, trace });
  }
});

function safeParse(json) {
  try { return JSON.parse(json); } catch { return json; }
}

// ── Route: GET /api/files/:name ───────────────────────────────────────────
// Serves files created by the agent's create_file tool.
app.get('/api/files/:name', async (req, res) => {
  try {
    await ensureWorkspace();
    const safe = basename(req.params.name).replace(/[^\w.\-]/g, '_');
    const p = resolve(WORKSPACE_DIR, safe);
    if (!p.startsWith(resolve(WORKSPACE_DIR))) return res.status(400).json({ error: 'bad path' });
    if (!existsSync(p)) return res.status(404).json({ error: 'not found' });
    res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
    res.sendFile(p);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Route: GET /api/files ─────────────────────────────────────────────────
app.get('/api/files', async (req, res) => {
  try {
    await ensureWorkspace();
    const names = await readdir(WORKSPACE_DIR);
    const files = await Promise.all(names.map(async n => {
      const s = await stat(join(WORKSPACE_DIR, n));
      return { name: n, bytes: s.size, mtime: s.mtime, url: `/api/files/${encodeURIComponent(n)}` };
    }));
    res.json({ files: files.sort((a, b) => new Date(b.mtime) - new Date(a.mtime)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Route: GET /api/health ────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const configured = Object.entries(PROVIDERS)
    .filter(([, p]) => p.keyless || (p.envKey && process.env[p.envKey]))
    .map(([id, p]) => ({ id, name: p.name, keyless: !!p.keyless }));
  res.json({ status: 'ok', version: '2.1.0', configuredProviders: configured });
});

// ── SPA fallback ──────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// Start server only when run directly (not imported by Vercel).
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => console.log(`CloudClaw running on http://localhost:${PORT}`));
}

export default app;
