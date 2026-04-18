# 🐾 CloudClaw AI

**A free, open-source, cloud-hosted AI assistant that works with ZERO setup.**

No API keys. No subscriptions. No data stored. Just open the page and start chatting.

CloudClaw is an OpenClaw-inspired simple AI assistant you can deploy for free
and use to send emails, search the web, and create files — all from a chat UI.

---

## ✨ Highlights

- **Zero-key default** — ships with the free [Pollinations](https://pollinations.ai) provider. Works immediately, no signup.
- **Streaming chat** — replies stream token-by-token with a stop button.
- **🤖 Agent mode** — the AI can use tools to complete real tasks:
  - `web_search` — search the public web (DuckDuckGo)
  - `fetch_url` — read a web page
  - `create_file` — save a text file the user can download
  - `draft_email` — produce a `mailto:` link to open in your email client
  - `generate_image` — create an image from a prompt (Pollinations, keyless)
  - `calculate` — safely evaluate a math expression (sqrt, sin, cos, ^, etc.)
  - `current_time` — get the current UTC time
- **Multi-provider** — optional extra keys for Groq, Google Gemini, Cohere, Together AI, Hugging Face.
- **Auto-fallback** — if one provider fails, the next one answers.
- **Ask All** — fan out the same question to every configured provider and compare.
- **Conversation history** — last 30 chats saved in your browser; click to resume.
- **Slash commands** — `/agent`, `/image`, `/search`, `/file`, `/export`, `/clear`, …
- **Markdown + code highlighting** via marked, DOMPurify, and highlight.js.
- **Export** any conversation as a `.md` file.
- **Nothing stored server-side** — keys and chats stay in your browser's `localStorage`; messages are never persisted on the server.
- **One-click deploy** — Vercel, Render, or Railway, all free tiers.

---

## 🚀 Quick start

```bash
git clone <this-repo>
cd cloudclaw
npm install
npm start
# open http://localhost:3000
```

That's it. No `.env` needed. The first conversation will go through Pollinations
for free. If you want to add optional providers, copy `.env.example` → `.env`.

---

## 🤖 Agent mode

Switch the sidebar toggle from **💬 Chat** to **🤖 Agent** and ask CloudClaw to
do things like:

- *"Search the web for the latest Node.js version and summarize."*
- *"Create a file called `todo.md` with 5 tasks for tomorrow."*
- *"Draft a friendly email to support@example.com about a refund."*
- *"Fetch https://example.com and summarize the page."*
- *"Generate an image of a cozy cabin in the snowy mountains at sunset."*
- *"Calculate the monthly payment on a $350,000 30-year mortgage at 6.5%."*

The AI chooses which tools to call, CloudClaw runs them server-side, and the
trace of every tool call + its result is shown inline. Files created by the
agent appear in the **Agent Files** panel with a download link.

Agent mode requires a provider that supports tool calling. The built-in
keyless Pollinations provider supports it, as do Groq and Together.

---

## 🌐 Providers

| Provider | Key needed? | Tool calling | Free tier |
|---|---|---|---|
| **Pollinations** | ❌ **No** (default) | ✅ | Unlimited anonymous tier |
| **Groq** | yes | ✅ | [console.groq.com](https://console.groq.com) |
| **Google Gemini** | yes | — | [aistudio.google.com](https://aistudio.google.com) |
| **Cohere** | yes | — | [dashboard.cohere.com](https://dashboard.cohere.com) |
| **Together AI** | yes | ✅ | [api.together.xyz](https://api.together.xyz) |
| **Hugging Face** | yes | — | [huggingface.co](https://huggingface.co/settings/tokens) |

Keys can be supplied either as environment variables on the server (great for
a team deployment) **or** pasted directly into the sidebar per-browser (great
for personal use — the key never leaves `localStorage`).

---

## ☁️ Deploy for free

### Vercel (recommended)

1. Push this repo to GitHub.
2. Go to https://vercel.com → Import.
3. Click Deploy. (No environment variables are required — Pollinations works
   without one.)
4. You get a free `*.vercel.app` URL.

### Render

1. Push this repo to GitHub.
2. https://render.com → New → Web Service → Connect repo.
3. Build command `npm install`, Start command `npm start`.
4. Click Deploy — free `*.onrender.com` URL.

### Railway

```bash
npm install -g @railway/cli
railway login && railway init && railway up
```

### Hugging Face Spaces

Create a new Space with SDK=Node.js and push this repo. Free `*.hf.space` URL.

---

## 🏗 How it works

```
Browser (app.js)
    │
    ▼
CloudClaw Server (Express)
    │
    ├── GET  /api/providers     list providers + whether keys are configured
    ├── POST /api/chat          one-shot chat completion
    ├── POST /api/chat/stream   SSE-streaming chat (token-by-token)
    ├── POST /api/agent         tool-calling loop (web_search, fetch_url, create_file, draft_email, generate_image, calculate, current_time)
    ├── GET  /api/files         list files created by the agent
    └── GET  /api/files/:name   download a created file
         │
         ├── Pollinations   (keyless, OpenAI-compatible)
         ├── Groq API       (OpenAI-compatible)
         ├── Google Gemini
         ├── Cohere Chat
         ├── Together AI    (OpenAI-compatible)
         └── Hugging Face Inference
```

On a **serverless** deployment (Vercel, Lambda) files are stored under `/tmp`
and live as long as the warm function instance. On a **persistent** host
(Render, Railway, a VPS) they're stored in the `workspace/` directory and
persist until you delete them.

---

## 📡 API reference

### `POST /api/chat`

```json
{
  "provider": "pollinations",
  "model": "openai",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello!" }
  ]
}
```

### `POST /api/agent`

Same body as `/api/chat`. Returns:

```json
{
  "reply":    "final answer",
  "provider": "Pollinations (no key needed)",
  "model":    "openai",
  "steps":    3,
  "trace":    [ { "step": 1, "tool": "web_search", "args": { … }, "result": { … } } ]
}
```

### `GET /api/providers`
Returns every provider, its models, and whether it's usable right now.

### `GET /api/files` / `GET /api/files/:name`
Lists and downloads files created by the agent's `create_file` tool.

### `GET /api/health`
`{ status: 'ok', configuredProviders: [ … ] }`.

---

## License

MIT — free to use, fork, and deploy.
