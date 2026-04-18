// Provider registry. Order matters — earlier = higher priority for auto-fallback.
// Providers marked `local: true` run entirely on the user's machine and take
// priority when auto-detection finds them reachable, to keep everything free
// and private by default.

export const PROVIDERS = {
  // ── LOCAL (free, private, preferred when reachable) ────────────────────
  ollama: {
    name: 'Ollama (local)',
    baseUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
    // We hit the OpenAI-compatible endpoint ollama ships with since 0.1.14.
    url: (base) => `${base}/v1/chat/completions`,
    envKey: null,
    models: [],               // discovered at runtime from /api/tags
    defaultModel: process.env.OLLAMA_MODEL || 'llama3.1',
    free: true,
    local: true,
    keyless: true,
    signupUrl: 'https://ollama.com/download',
    format: 'openai',
    supportsTools: true,
    description: 'Local LLM runtime — run Llama, Qwen, Mistral, Phi on your own machine.',
  },
  lmstudio: {
    name: 'LM Studio (local)',
    baseUrl: process.env.LMSTUDIO_URL || 'http://localhost:1234',
    url: (base) => `${base}/v1/chat/completions`,
    envKey: null,
    models: [],
    defaultModel: process.env.LMSTUDIO_MODEL || 'local-model',
    free: true,
    local: true,
    keyless: true,
    signupUrl: 'https://lmstudio.ai',
    format: 'openai',
    supportsTools: true,
    description: 'Local LLM runtime with a polished desktop UI.',
  },
  llamacpp: {
    name: 'llama.cpp server (local)',
    baseUrl: process.env.LLAMACPP_URL || 'http://localhost:8080',
    url: (base) => `${base}/v1/chat/completions`,
    envKey: null,
    models: ['local'],
    defaultModel: 'local',
    free: true,
    local: true,
    keyless: true,
    signupUrl: 'https://github.com/ggerganov/llama.cpp',
    format: 'openai',
    supportsTools: true,
    description: 'Bare-metal llama.cpp `server` binary, OpenAI-compatible.',
  },

  // ── FREE CLOUD (keyless) ────────────────────────────────────────────────
  pollinations: {
    name: 'Pollinations (free, no key)',
    url: () => 'https://text.pollinations.ai/openai',
    envKey: null,
    models: ['openai', 'openai-fast', 'openai-large', 'mistral', 'llama', 'gemini'],
    defaultModel: 'openai',
    free: true,
    keyless: true,
    signupUrl: 'https://pollinations.ai',
    format: 'openai',
    supportsTools: true,
    description: 'Free cloud OpenAI-compatible proxy, no signup required.',
  },

  // ── FREE CLOUD (key required) ──────────────────────────────────────────
  groq: {
    name: 'Groq',
    url: () => 'https://api.groq.com/openai/v1/chat/completions',
    envKey: 'GROQ_API_KEY',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768', 'gemma2-9b-it'],
    defaultModel: 'llama-3.3-70b-versatile',
    free: true,
    signupUrl: 'https://console.groq.com',
    format: 'openai',
    supportsTools: true,
    description: 'Fastest Llama 3 inference anywhere. Generous free tier.',
  },
  gemini: {
    name: 'Google Gemini',
    url: (_, model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    envKey: 'GEMINI_API_KEY',
    models: ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'],
    defaultModel: 'gemini-2.0-flash',
    free: true,
    signupUrl: 'https://aistudio.google.com',
    format: 'gemini',
    supportsTools: false,
    description: 'Very capable free tier; no native tool-calling in this adapter.',
  },
  cohere: {
    name: 'Cohere',
    url: () => 'https://api.cohere.com/v1/chat',
    envKey: 'COHERE_API_KEY',
    models: ['command-r-plus', 'command-r', 'command'],
    defaultModel: 'command-r-plus',
    free: true,
    signupUrl: 'https://dashboard.cohere.com',
    format: 'cohere',
    supportsTools: false,
    description: 'Command R family; free trial tier.',
  },
  together: {
    name: 'Together AI',
    url: () => 'https://api.together.xyz/v1/chat/completions',
    envKey: 'TOGETHER_API_KEY',
    models: ['meta-llama/Llama-3-70b-chat-hf', 'mistralai/Mixtral-8x7B-Instruct-v0.1', 'Qwen/Qwen2.5-72B-Instruct-Turbo'],
    defaultModel: 'meta-llama/Llama-3-70b-chat-hf',
    free: true,
    signupUrl: 'https://api.together.xyz',
    format: 'openai',
    supportsTools: true,
    description: 'Open-source model hosting with a free credit tier.',
  },
  huggingface: {
    name: 'Hugging Face',
    url: (_, model) => `https://api-inference.huggingface.co/models/${model}`,
    envKey: 'HF_API_KEY',
    models: ['mistralai/Mistral-7B-Instruct-v0.3', 'HuggingFaceH4/zephyr-7b-beta'],
    defaultModel: 'mistralai/Mistral-7B-Instruct-v0.3',
    free: true,
    signupUrl: 'https://huggingface.co/settings/tokens',
    format: 'huggingface',
    supportsTools: false,
    description: 'HF Inference API — broad model catalog, rate-limited free tier.',
  },
};

// Default priority order for auto-fallback. Local first, then keyless cloud,
// then key-based cloud.
export const DEFAULT_ORDER = [
  'ollama', 'lmstudio', 'llamacpp',
  'pollinations',
  'groq', 'gemini', 'together', 'cohere', 'huggingface',
];

export function buildUrl(provider, model) {
  const base = provider.baseUrl || '';
  return typeof provider.url === 'function' ? provider.url(base, model) : provider.url;
}
