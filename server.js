// OpenClaw server — an open-source, local-first AI assistant.
// See README.md for the big picture. This file wires HTTP routes to the
// modular provider / skills / brain layers in lib/ and skills/.

import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join, resolve, basename } from 'path';
import { mkdir, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import 'dotenv/config';

import { PROVIDERS, DEFAULT_ORDER } from './lib/providers.js';
import { chatCompletion, callOpenAI, probeLocal, clampGenerationOpts } from './lib/llm.js';
import { loadSkills } from './skills/index.js';
import { runAgent, SYSTEM_PROMPT, buildMemoryBrief } from './lib/brain.js';
import { createMemory } from './lib/memory.js';
import { logger, makeRequestId } from './lib/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Request ID middleware for end-to-end tracing in logs.
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || makeRequestId();
  req.log = logger.child({ rid: req.id });
  res.setHeader('X-Request-Id', req.id);
  next();
});

app.use(express.static(join(__dirname, 'public')));

// Writable workspace. Serverless (Vercel) is read-only outside /tmp.
const WORKSPACE_DIR = (() => {
  const preferred = process.env.WORKSPACE_DIR || join(__dirname, 'workspace');
  try {
    if (!existsSync(preferred)) {
      if (process.env.VERCEL === '1' || process.env.AWS_LAMBDA_FUNCTION_NAME) {
        return '/tmp/openclaw-workspace';
      }
    }
    return preferred;
  } catch {
    return '/tmp/openclaw-workspace';
  }
})();

async function ensureWorkspace() {
  if (!existsSync(WORKSPACE_DIR)) await mkdir(WORKSPACE_DIR, { recursive: true });
}

// ── Boot: load skills, create memory ──────────────────────────────────────
await ensureWorkspace();
const memory = createMemory({ dir: WORKSPACE_DIR });
const { skills, defs: TOOL_DEFS } = await loadSkills();
logger.info('skills loaded', { count: Object.keys(skills).length, names: Object.keys(skills) });

// Local-provider auto-detection: we probe once at boot and every 60s.
let LOCAL_STATUS = {};  // providerId -> { reachable, models }
async function refreshLocalStatus() {
  for (const id of Object.keys(PROVIDERS)) {
    const p = PROVIDERS[id];
    if (!p.local) continue;
    const status = await probeLocal(p);
    LOCAL_STATUS[id] = status;
    if (status.reachable && status.models?.length) {
      PROVIDERS[id].models = status.models;
      if (!PROVIDERS[id].models.includes(PROVIDERS[id].defaultModel) && status.models[0]) {
        PROVIDERS[id].defaultModel = status.models[0];
      }
    }
  }
}
refreshLocalStatus().catch(() => {});
setInterval(() => refreshLocalStatus().catch(() => {}), 60_000).unref?.();

// ── Helpers ────────────────────────────────────────────────────────────────
function resolveProvider(id) {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`unknown provider: ${id}`);
  return p;
}

function getKey(provider, apiKey) {
  if (provider.keyless) return null;
  return apiKey || (provider.envKey && process.env[provider.envKey]) || null;
}

function isProviderUsable(id) {
  const p = PROVIDERS[id];
  if (!p) return false;
  if (p.local) return !!LOCAL_STATUS[id]?.reachable;
  if (p.keyless) return true;
  return !!(p.envKey && process.env[p.envKey]);
}

// ── Route: GET /api/providers ─────────────────────────────────────────────
app.get('/api/providers', (req, res) => {
  const result = {};
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const localStatus = LOCAL_STATUS[id];
    result[id] = {
      name: p.name,
      description: p.description,
      models: p.models,
      defaultModel: p.defaultModel,
      free: p.free,
      local: !!p.local,
      keyless: !!p.keyless,
      signupUrl: p.signupUrl,
      configured: p.local
        ? !!localStatus?.reachable
        : p.keyless || !!(p.envKey && process.env[p.envKey]),
      supportsTools: !!p.supportsTools,
      reachable: p.local ? !!localStatus?.reachable : undefined,
    };
  }
  res.json(result);
});

// ── Route: POST /api/chat ─────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { provider: providerId = DEFAULT_ORDER[0], model, messages, apiKey, temperature, max_tokens } = req.body;
  const gen = clampGenerationOpts({ temperature, max_tokens });

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  let provider;
  try { provider = resolveProvider(providerId); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const key = getKey(provider, apiKey);
  if (!provider.keyless && !key) {
    return res.status(400).json({
      error: `No API key for ${provider.name}. Set ${provider.envKey} env var or enter it in the sidebar.`,
    });
  }

  try {
    const msg = await chatCompletion(provider, messages, model, key, gen);
    res.json({ reply: msg.content, provider: provider.name, model: model || provider.defaultModel });
  } catch (err) {
    req.log.error('chat failed', { provider: providerId, err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Route: POST /api/chat/stream ──────────────────────────────────────────
app.post('/api/chat/stream', async (req, res) => {
  const { provider: providerId = DEFAULT_ORDER[0], model, messages, apiKey, temperature, max_tokens } = req.body;
  const gen = clampGenerationOpts({ temperature, max_tokens });

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  let provider;
  try { provider = resolveProvider(providerId); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const key = getKey(provider, apiKey);
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

  if (provider.format !== 'openai') {
    try {
      const msg = await chatCompletion(provider, messages, model, key, gen);
      send('delta', { content: msg.content || '' });
      send('done', { provider: provider.name, model: model || provider.defaultModel });
    } catch (err) {
      send('error', { message: err.message });
    }
    return res.end();
  }

  const { buildUrl } = await import('./lib/providers.js');

  // For keyless providers (notably Pollinations) we rotate through their
  // model list on transient upstream failures before giving up, which hides
  // a lot of intermittent 5xx/429 flakiness from the user.
  const candidateModels = provider.keyless
    ? Array.from(new Set([model || provider.defaultModel, ...(provider.models || [])])).slice(0, 4)
    : [model || provider.defaultModel];

  let upstream = null;
  let lastErr = null;
  let usedModel = candidateModels[0];
  for (const m of candidateModels) {
    const url = buildUrl(provider, m);
    let attempt = 0;
    while (attempt < (provider.keyless ? 2 : 1)) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(key ? { Authorization: `Bearer ${key}` } : {}),
          },
          body: JSON.stringify({
            model: m,
            messages,
            stream: true,
            max_tokens: gen.max_tokens,
            temperature: gen.temperature,
          }),
        });
        if (r.ok && r.body) { upstream = r; usedModel = m; break; }
        lastErr = new Error(`upstream status ${r.status}`);
        // Only retry same model on 5xx/429.
        if (r.status < 500 && ![408, 425, 429].includes(r.status)) break;
      } catch (e) { lastErr = e; }
      attempt++;
      await new Promise(res => setTimeout(res, 300 * attempt));
    }
    if (upstream) break;
  }

  if (!upstream || !upstream.ok || !upstream.body) {
    const msg = lastErr?.message || 'upstream unreachable';
    send('error', { message: msg });
    return res.end();
  }
  model = usedModel;

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
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') { send('done', { provider: provider.name, model: model || provider.defaultModel }); return res.end(); }
          try {
            const obj = JSON.parse(payload);
            const delta = obj.choices?.[0]?.delta?.content;
            if (delta) send('delta', { content: delta });
          } catch { /* malformed chunk */ }
        }
      }
    }
    send('done', { provider: provider.name, model: model || provider.defaultModel });
  } catch (err) {
    send('error', { message: err.message });
  }
  res.end();
});

// ── Route: POST /api/agent ────────────────────────────────────────────────
app.post('/api/agent', async (req, res) => {
  const {
    provider: providerId = DEFAULT_ORDER[0],
    model,
    messages,
    apiKey,
    maxSteps = 8,
    temperature,
    max_tokens,
  } = req.body;
  const gen = clampGenerationOpts({ temperature, max_tokens });

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  let provider;
  try { provider = resolveProvider(providerId); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  if (!provider.supportsTools) {
    return res.status(400).json({
      error: `${provider.name} does not support tool calling. Use a local LLM (Ollama/LM Studio), Pollinations, Groq, or Together.`,
    });
  }
  const key = getKey(provider, apiKey);
  if (!provider.keyless && !key) {
    return res.status(400).json({ error: `No API key for ${provider.name}.` });
  }

  try {
    // Extract the user-supplied system prompt (optional) + user messages.
    const userSystem = messages.find(m => m.role === 'system')?.content || '';
    const userMsgs = messages.filter(m => m.role !== 'system');

    const memoryBrief = await buildMemoryBrief(memory, userMsgs);
    const systemContent = SYSTEM_PROMPT({
      memoryBrief,
      toolNames: Object.keys(skills),
      currentTime: new Date().toISOString(),
    }) + (userSystem ? '\n\nAdditional instructions from the user:\n' + userSystem : '');

    const baseMessages = [
      { role: 'system', content: systemContent },
      ...userMsgs,
    ];

    const ctx = {
      workspaceDir: WORKSPACE_DIR,
      memory,
      logger: req.log,
      requestId: req.id,
    };

    const result = await runAgent({
      provider,
      callOpenAI,
      messages: baseMessages,
      model,
      apiKey: key,
      skills,
      toolDefs: TOOL_DEFS,
      maxSteps: Math.min(Math.max(1, maxSteps | 0), 12),
      ctx,
      temperature: gen.temperature,
      max_tokens: gen.max_tokens,
    });

    req.log.info('agent done', { steps: result.steps, provider: providerId });
    res.json({
      reply: result.reply,
      provider: provider.name,
      model: model || provider.defaultModel,
      steps: result.steps,
      trace: result.trace,
      truncated: !!result.truncated,
    });
  } catch (err) {
    req.log.error('agent failed', { err: err.message, provider: providerId });
    res.status(500).json({ error: err.message });
  }
});

// ── Route: memory inspection ──────────────────────────────────────────────
app.get('/api/memory', async (req, res) => {
  const list = await memory.list({ limit: 200 });
  res.json({ entries: list });
});

app.post('/api/memory', async (req, res) => {
  const { text, tags, importance } = req.body;
  const out = await memory.add({ text, tags, importance });
  res.json(out);
});

app.delete('/api/memory/:id', async (req, res) => {
  const out = await memory.forget({ id: req.params.id });
  res.json(out);
});

app.delete('/api/memory', async (_req, res) => {
  const out = await memory.clear();
  res.json(out);
});

// ── Route: files ──────────────────────────────────────────────────────────
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

app.get('/api/files', async (_req, res) => {
  try {
    await ensureWorkspace();
    const names = await readdir(WORKSPACE_DIR);
    const files = await Promise.all(
      names
        .filter(n => n !== 'memory.json')
        .map(async n => {
          const s = await stat(join(WORKSPACE_DIR, n));
          if (s.isDirectory()) return null;
          return { name: n, bytes: s.size, mtime: s.mtime, url: `/api/files/${encodeURIComponent(n)}` };
        })
    );
    res.json({ files: files.filter(Boolean).sort((a, b) => new Date(b.mtime) - new Date(a.mtime)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Route: health ─────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  const configured = Object.entries(PROVIDERS)
    .filter(([id]) => isProviderUsable(id))
    .map(([id, p]) => ({ id, name: p.name, keyless: !!p.keyless, local: !!p.local }));
  res.json({
    status: 'ok',
    version: '3.0.0',
    name: 'OpenClaw',
    configuredProviders: configured,
    skillCount: Object.keys(skills).length,
    skills: Object.keys(skills),
  });
});

// ── Optional messaging adapters (loaded after HTTP is ready) ──────────────
async function startAdapters() {
  if (process.env.TELEGRAM_BOT_TOKEN) {
    try {
      const { startTelegram } = await import('./adapters/telegram.js');
      await startTelegram({
        token: process.env.TELEGRAM_BOT_TOKEN,
        endpoint: `http://localhost:${PORT}/api/agent`,
        logger: logger.child({ adapter: 'telegram' }),
      });
      logger.info('telegram adapter started');
    } catch (e) {
      logger.error('telegram adapter failed to start', { err: e.message });
    }
  }
}

// ── SPA fallback ──────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    logger.info(`OpenClaw listening on http://localhost:${PORT}`, {
      skills: Object.keys(skills),
      providers: Object.keys(PROVIDERS),
    });
    startAdapters().catch(() => {});
  });
}

export default app;
