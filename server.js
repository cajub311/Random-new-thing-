import express from 'express';
import cors from 'cors';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ── Provider registry ──────────────────────────────────────────────────────
const PROVIDERS = {
  groq: {
    name: 'Groq (Llama 3)',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    envKey: 'GROQ_API_KEY',
    models: ['llama3-70b-8192', 'llama3-8b-8192', 'mixtral-8x7b-32768'],
    defaultModel: 'llama3-70b-8192',
    free: true,
    signupUrl: 'https://console.groq.com',
    format: 'openai',
  },
  gemini: {
    name: 'Google Gemini',
    url: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
    envKey: 'GEMINI_API_KEY',
    models: ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash-exp'],
    defaultModel: 'gemini-1.5-flash',
    free: true,
    signupUrl: 'https://aistudio.google.com',
    format: 'gemini',
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
  },
  together: {
    name: 'Together AI',
    url: 'https://api.together.xyz/v1/chat/completions',
    envKey: 'TOGETHER_API_KEY',
    models: ['meta-llama/Llama-3-70b-chat-hf', 'mistralai/Mixtral-8x7B-Instruct-v0.1'],
    defaultModel: 'meta-llama/Llama-3-70b-chat-hf',
    free: true,
    signupUrl: 'https://api.together.xyz',
    format: 'openai',
  },
  huggingface: {
    name: 'Hugging Face',
    url: 'https://api-inference.huggingface.co/models/{model}',
    envKey: 'HF_API_KEY',
    models: ['mistralai/Mistral-7B-Instruct-v0.3', 'HuggingFaceH4/zephyr-7b-beta'],
    defaultModel: 'mistralai/Mistral-7B-Instruct-v0.3',
    free: true,
    signupUrl: 'https://huggingface.co',
    format: 'huggingface',
  },
};

// ── Helper: call OpenAI-compatible API ────────────────────────────────────
async function callOpenAI(provider, messages, model, apiKey) {
  const res = await fetch(provider.url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model || provider.defaultModel, messages, stream: false, max_tokens: 4096 }),
  });
  if (!res.ok) throw new Error(`${provider.name} API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content;
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
  if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.candidates[0].content.parts[0].text;
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
  if (!res.ok) throw new Error(`Cohere API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.text;
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
  if (!res.ok) throw new Error(`Hugging Face API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return Array.isArray(data) ? data[0]?.generated_text : data.generated_text;
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
      signupUrl: p.signupUrl,
      configured: !!(process.env[p.envKey]),
    };
  }
  res.json(result);
});

// ── Route: POST /api/chat ─────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { provider: providerId = 'groq', model, messages, apiKey } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const provider = PROVIDERS[providerId];
  if (!provider) return res.status(400).json({ error: `Unknown provider: ${providerId}` });

  const key = apiKey || process.env[provider.envKey];
  if (!key) {
    return res.status(400).json({
      error: `No API key for ${provider.name}. Set ${provider.envKey} env var or pass apiKey in request. Get a free key at ${provider.signupUrl}`,
    });
  }

  try {
    let reply;
    if (provider.format === 'openai') reply = await callOpenAI(provider, messages, model, key);
    else if (provider.format === 'gemini') reply = await callGemini(provider, messages, model, key);
    else if (provider.format === 'cohere') reply = await callCohere(provider, messages, model, key);
    else if (provider.format === 'huggingface') reply = await callHuggingFace(provider, messages, model, key);
    res.json({ reply, provider: provider.name, model: model || provider.defaultModel });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Route: GET /api/health ─────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const configured = Object.entries(PROVIDERS)
    .filter(([, p]) => process.env[p.envKey])
    .map(([id, p]) => ({ id, name: p.name }));
  res.json({ status: 'ok', version: '1.0.0', configuredProviders: configured });
});

app.listen(PORT, () => console.log(`CloudClaw running on http://localhost:${PORT}`));
