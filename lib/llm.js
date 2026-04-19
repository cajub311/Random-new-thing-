// Provider-agnostic chat completion layer. Returns an OpenAI-style message
// object: { role: 'assistant', content: string, tool_calls?: [...] }.

import { buildUrl } from './providers.js';

export async function callOpenAI(provider, messages, model, apiKey, { tools } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const body = {
    model: model || provider.defaultModel,
    messages,
    stream: false,
    max_tokens: 4096,
  };
  if (tools && tools.length) body.tools = tools;
  const url = buildUrl(provider, body.model);

  // Retry transient errors (429 / 5xx / network) with exp backoff.
  // This dramatically reduces Pollinations flakiness without masking real errors.
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (res.ok) {
        const data = await res.json();
        const msg = data.choices?.[0]?.message;
        if (!msg) throw new Error(`${provider.name} returned no message`);
        if (!msg.content && !msg.tool_calls?.length && msg.reasoning_content) {
          msg.content = '';
          msg.__reasoning_only = String(msg.reasoning_content);
        }
        return msg;
      }
      const txt = await res.text().catch(() => '');
      lastErr = new Error(`${provider.name} error ${res.status}: ${txt}`);
      // Don't retry client errors other than 408/425/429.
      if (res.status < 500 && ![408, 425, 429].includes(res.status)) throw lastErr;
    } catch (e) {
      lastErr = e;
      if (/abort|TypeError|fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(e.message || '') === false
          && !/(5\d{2}|429|408|425)/.test(e.message || '')) {
        // Non-retryable — bubble immediately.
        if (attempt === 0) throw e;
      }
    }
    await new Promise(r => setTimeout(r, 400 * (attempt + 1) ** 2));
  }
  throw lastErr || new Error(`${provider.name}: exhausted retries`);
}

export async function callGemini(provider, messages, model, apiKey) {
  const m = model || provider.defaultModel;
  const url = `${buildUrl(provider, m)}?key=${apiKey}`;
  const contents = messages
    .filter(msg => msg.role !== 'system' && msg.role !== 'tool')
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

export async function callCohere(provider, messages, model, apiKey) {
  const systemMsg = messages.find(m => m.role === 'system')?.content || '';
  const history = messages.filter(m => m.role !== 'system' && m.role !== 'tool').slice(0, -1).map(m => ({
    role: m.role === 'assistant' ? 'CHATBOT' : 'USER',
    message: m.content,
  }));
  const lastMsg = messages.filter(m => m.role !== 'system' && m.role !== 'tool').slice(-1)[0];
  const res = await fetch(buildUrl(provider), {
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

export async function callHuggingFace(provider, messages, model, apiKey) {
  const m = model || provider.defaultModel;
  const url = buildUrl(provider, m);
  const prompt = messages.map(msg => {
    if (msg.role === 'system') return `<s>[INST] <<SYS>>\n${msg.content}\n<</SYS>>\n\n`;
    if (msg.role === 'user') return `${msg.content} [/INST]`;
    if (msg.role === 'tool') return '';
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

export async function chatCompletion(provider, messages, model, apiKey, opts = {}) {
  if (provider.format === 'openai')      return callOpenAI(provider, messages, model, apiKey, opts);
  if (provider.format === 'gemini')      return callGemini(provider, messages, model, apiKey);
  if (provider.format === 'cohere')      return callCohere(provider, messages, model, apiKey);
  if (provider.format === 'huggingface') return callHuggingFace(provider, messages, model, apiKey);
  throw new Error(`Unknown format: ${provider.format}`);
}

