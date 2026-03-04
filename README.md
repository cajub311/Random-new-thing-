# 🐾 CloudClaw AI

**A free, open-source, cloud-hosted AI assistant with multi-provider support.**

No subscriptions. No data stored. Just pure free AI power in your browser.

---

## Features

- **5 free AI providers** — Groq, Google Gemini, Cohere, Together AI, Hugging Face
- **Multiple models per provider** — Llama 3 70B, Gemini 1.5 Pro, Command R+, Mixtral, and more
- **Beautiful chat UI** — markdown rendering, code highlighting, copy buttons, file attachments
- **No data stored** — keys stay in your browser's localStorage, messages never persisted
- **One-click deploy** — Vercel, Render, or Railway, all with free tiers

---

## Free AI Providers & Where to Get Keys

| Provider | Free Models | Sign Up |
|---|---|---|
| **Groq** | Llama 3 70B, Llama 3 8B, Mixtral 8x7B | https://console.groq.com |
| **Google Gemini** | Gemini 1.5 Flash, Gemini 1.5 Pro, Gemini 2.0 Flash | https://aistudio.google.com |
| **Cohere** | Command R+, Command R, Command | https://dashboard.cohere.com |
| **Together AI** | Llama 3 70B, Mixtral 8x7B | https://api.together.xyz |
| **Hugging Face** | Mistral 7B, Zephyr 7B, 100+ more | https://huggingface.co/settings/tokens |

> You only need **one key** to get started!

---

## Local Development

```bash
# 1. Clone
git clone <this-repo>
cd cloudclaw

# 2. Install dependencies
npm install

# 3. Add your free API key(s)
cp .env.example .env
# Edit .env and add at least one key

# 4. Run
npm start
# Open http://localhost:3000
```

---

## Deploy for Free

### Option 1: Vercel (Recommended — fastest)

1. Push this repo to GitHub
2. Go to https://vercel.com → Import your repo
3. Add environment variables (your API keys) in the Vercel dashboard
4. Click Deploy — done! You get a free `*.vercel.app` URL

### Option 2: Render

1. Push this repo to GitHub
2. Go to https://render.com → New → Web Service → Connect repo
3. Build command: `npm install`, Start command: `npm start`
4. Add environment variables in the Render dashboard
5. Click Deploy — free `*.onrender.com` URL

### Option 3: Railway

```bash
# Install Railway CLI
npm install -g @railway/cli
railway login
railway init
railway up
# Set env vars: railway variables set GROQ_API_KEY=your_key
```

### Option 4: Hugging Face Spaces

Create a new Space with SDK=Node.js and push this repo. Free `*.hf.space` URL.

---

## How It Works

```
Browser (app.js)
    │
    ▼
CloudClaw Server (server.js / Express)
    │
    ├── /api/providers  →  list all providers & which are configured
    ├── /api/chat       →  route to the right AI provider
    └── /public/        →  serve the frontend
         │
         ├── Groq API (OpenAI-compatible)
         ├── Google Gemini API
         ├── Cohere Chat API
         ├── Together AI (OpenAI-compatible)
         └── Hugging Face Inference API
```

API keys can be:
- **Server-side**: set as environment variables (recommended for shared deployments)
- **Client-side**: entered in the sidebar and sent per-request (good for personal use)

---

## API

### `POST /api/chat`

```json
{
  "provider": "groq",
  "model": "llama3-70b-8192",
  "apiKey": "optional-if-set-server-side",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello!" }
  ]
}
```

Response:
```json
{
  "reply": "Hello! How can I help you today?",
  "provider": "Groq (Llama 3)",
  "model": "llama3-70b-8192"
}
```

### `GET /api/providers`

Returns all available providers, their models, and whether they are server-configured.

### `GET /api/health`

Returns server status and list of configured providers.

---

## License

MIT — free to use, fork, and deploy.
