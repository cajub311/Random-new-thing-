# 🐾 OpenClaw

**Free, local-first, open-source personal AI assistant.**
Runs on your own machine with Ollama or LM Studio. Falls back to keyless
cloud providers so it Just Works even if you haven't installed anything.
Talks to a real agent that can search the web, create files, draft emails,
generate images, do math, and remember things about you.

[![License: MIT](https://img.shields.io/badge/license-MIT-6c63ff.svg)](LICENSE)
[![Node.js: ≥18](https://img.shields.io/badge/node-%E2%89%A518-339933.svg)](https://nodejs.org)
[![Local-first](https://img.shields.io/badge/local--first-ollama%20%7C%20lm%20studio-22c55e.svg)](https://ollama.com)

---

## ✨ Why OpenClaw

- **100% free to run.** No paid API required. If you have Ollama or LM Studio,
  OpenClaw uses *your own* LLM — private, offline, unlimited. If you don't,
  it falls back to a free keyless cloud provider.
- **Smart agent brain.** ReAct-style system prompt, explicit planning, a
  `final_answer` tool for clean termination, and long-term memory so it
  remembers your name, preferences, and ongoing projects across sessions.
- **Pluggable skills.** One file per tool. Drop a `*.skill.js` in `skills/`,
  restart, and the LLM can use it. Currently shipped: `web_search`,
  `fetch_url`, `create_file`, `read_file`, `draft_email`, `generate_image`,
  `calculate`, `current_time`, `remember`, `recall`, `final_answer`.
- **Hardened.** Every external URL the agent fetches is checked against an
  SSRF-blocking resolver (no localhost, no private ranges, no metadata IPs).
  File writes are sandboxed to a workspace directory.
- **Streaming UI.** Token-by-token output, stop button, session history,
  slash commands, markdown export, proper code highlighting.
- **Optional Telegram bot.** Drop in a bot token, get a Telegram assistant
  with the same brain.

---

## 🚀 Quick start

```bash
git clone <this-repo>
cd openclaw
npm install
npm start
# open http://localhost:3000
```

That's it — no `.env` needed. OpenClaw will:

1. Probe `localhost:11434` for **Ollama** and `localhost:1234` for **LM Studio**
   and auto-connect if it finds one.
2. If neither is running, use the free keyless **Pollinations** cloud
   provider so you can still start chatting.

### Running a truly local stack

Install Ollama and pull a tool-capable model:

```bash
# macOS / Linux
curl -fsSL https://ollama.com/install.sh | sh
ollama pull llama3.1          # 4.7GB, great all-rounder
# or
ollama pull qwen2.5:7b        # excellent tool-calling in ≤ 8GB RAM
```

Start OpenClaw — it will list the model you pulled in the sidebar and use
it for everything, including agent mode, with zero internet round-trips.

---

## 🧠 Architecture

```
┌─────────────────────┐      ┌───────────────────────────────────┐
│  Web UI (public/)   │      │   Optional messaging adapters     │
│  streaming, skills  │      │   adapters/telegram.js            │
│  panel, memory UI   │      │   (opt-in via TELEGRAM_BOT_TOKEN) │
└──────────┬──────────┘      └──────────────┬────────────────────┘
           │ /api/chat/stream, /api/agent   │ POST /api/agent
           ▼                                ▼
   ┌──────────────────────────────────────────────────┐
   │  server.js  —  Express HTTP + SSE streaming      │
   └──────────────────┬───────────────────────────────┘
                      ▼
        ┌─────────────────────────────┐
        │  lib/brain.js               │   System prompt, tool loop, reflection
        │  lib/llm.js                 │   OpenAI / Gemini / Cohere / HF adapters
        │  lib/providers.js           │   Registry with local-first priority
        │  lib/memory.js              │   Long-term memory (BM25-ish on JSON)
        │  lib/safe-fetch.js          │   SSRF-blocking fetch wrapper
        │  lib/logger.js              │   Structured logger w/ request IDs
        └─────────────────────────────┘
                      │
       ┌──────────────┴──────────────┐
       ▼                             ▼
  ┌─────────────────┐         ┌─────────────────────┐
  │  skills/*.js    │         │  LLM backends       │
  │  auto-loaded    │         │  • Ollama (local)   │
  │  tools          │         │  • LM Studio (local)│
  │                 │         │  • llama.cpp (local)│
  │ web_search      │         │  • Pollinations     │
  │ fetch_url       │         │  • Groq / Gemini /  │
  │ create_file     │         │    Together / HF /  │
  │ read_file       │         │    Cohere           │
  │ draft_email     │         └─────────────────────┘
  │ generate_image  │
  │ calculate       │
  │ current_time    │
  │ remember        │
  │ recall          │
  │ final_answer    │
  └─────────────────┘
```

---

## 🧰 Built-in skills

| Skill | What it does |
|---|---|
| `web_search`     | DuckDuckGo HTML scrape — organic results with titles & snippets |
| `fetch_url`      | Download a URL and strip HTML to plain text. SSRF-guarded. |
| `create_file`    | Write a text file (up to 1MB) into the workspace |
| `read_file`      | Read a previously created workspace file |
| `draft_email`    | Produce a `mailto:` link you can open in your email client |
| `generate_image` | Free keyless image generation via Pollinations |
| `calculate`      | Sandboxed math evaluator (`sqrt`, `sin`, `log`, `^`, `pi`, …) |
| `current_time`   | UTC timestamp |
| `remember`       | Save a fact to long-term memory with optional tags & importance |
| `recall`         | BM25-ish search over saved memories |
| `final_answer`   | Clean exit from the tool loop with the final markdown reply |

Adding a new skill is a single file. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## 🔌 Providers

| Provider | Local? | Key? | Tools? | Notes |
|---|:---:|:---:|:---:|---|
| **Ollama**            | ✅ | — | ✅ | Auto-detected on localhost:11434 |
| **LM Studio**         | ✅ | — | ✅ | Auto-detected on localhost:1234 |
| **llama.cpp server**  | ✅ | — | ✅ | `LLAMACPP_URL` defaults to :8080 |
| **Pollinations**      | — | — | ✅ | Keyless cloud, default fallback |
| **Groq**              | — | ✅ | ✅ | Fastest Llama inference |
| **Google Gemini**     | — | ✅ | — | Generous free tier |
| **Together AI**       | — | ✅ | ✅ | Big OSS-model catalog |
| **Cohere**            | — | ✅ | — | Command R family |
| **Hugging Face**      | — | ✅ | — | HF Inference API |

Keys go in `.env` or in the browser sidebar (they live in `localStorage`
and never touch disk on the server).

---

## 🤖 Agent mode in action

Type into the UI or send via the Telegram bot:

- *"Search the web for the latest AI news and summarize the top 3 stories."*
- *"Create a file called `todo.md` with 5 tasks for tomorrow."*
- *"Draft an email to boss@example.com asking about time off."*
- *"Generate an image of a cozy cabin in snowy mountains."*
- *"Calculate the monthly payment on a $350,000 30-year mortgage at 6.5%."*
- *"My name is Sam and I'm working on a game in Godot — remember that."*
  (next session) *"What engine am I using for my game?"*

The agent plans, calls tools, reflects on their output, and streams a clean
markdown answer. Every step is visible in the tool-call trace UI.

---

## 📡 HTTP API

```
GET    /api/health          → version, skills, configured providers
GET    /api/providers       → provider catalog (incl. local reachability)
POST   /api/chat            → one-shot chat completion
POST   /api/chat/stream     → SSE token streaming
POST   /api/agent           → tool-calling loop (memory-aware)
GET    /api/files           → list workspace files
GET    /api/files/:name     → download a workspace file
GET    /api/memory          → list long-term memory entries
POST   /api/memory          → add a memory entry { text, tags, importance }
DELETE /api/memory/:id      → forget one entry
DELETE /api/memory          → clear all memory
```

Every response carries an `X-Request-Id` header for log correlation.

---

## 💬 Telegram bot

```bash
# Create a bot via @BotFather on Telegram, get the token.
export TELEGRAM_BOT_TOKEN=123:abc...
npm start
```

OpenClaw launches a long-polling Telegram adapter that talks to the local
`/api/agent` endpoint. `/start` introduces the bot, `/reset` clears the chat
history. All other messages go to the agent. Long-term memory persists
across Telegram chats *and* the web UI.

---

## ☁️ Deploy for free

### Vercel

```bash
npx vercel
```

Works out of the box. `vercel.json` ships with a 60s function duration and
512MB memory so agent tool chains finish comfortably.

### Render / Railway / Fly.io / a Raspberry Pi

It's a plain Node/Express server. Any Node 18+ host works.

### Docker

(Feel free to contribute a Dockerfile — a minimal one is `FROM node:20-alpine`
with `npm ci && npm start`.)

---

## 🔐 Security notes

- `fetch_url` uses `lib/safe-fetch.js`, which resolves the hostname and
  refuses private/loopback addresses, cloud metadata IPs, and non-http(s)
  schemes. Redirects are re-validated hop-by-hop.
- `create_file` sanitizes filenames, caps content at 1MB, and refuses
  anything that escapes the workspace directory.
- `calculate` runs inside `new Function` with a strict identifier allowlist
  (only `Math.*`), never touches `globalThis`.
- Long-term memory is stored as plain JSON under the workspace directory.
  Delete that file (or `DELETE /api/memory`) to wipe it.
- No telemetry. Nothing is sent anywhere except the LLM provider you choose.

---

## 🗺 Roadmap ideas

- Vector memory via `nomic-embed-text` through Ollama (drop-in replacement
  for the BM25 retriever in `lib/memory.js`).
- Additional adapters: Discord, Slack, WhatsApp (Baileys), Signal, Matrix.
- Voice I/O with Whisper.cpp + Piper, both free and local.
- A proper plugin registry (ClawHub-style).
- Scheduled tasks (cron-like "every morning, summarize my inbox").
- Sandboxed shell tool (opt-in) for power users.

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## 📜 License

MIT — see [LICENSE](LICENSE).
