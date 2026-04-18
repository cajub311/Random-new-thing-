# Contributing to OpenClaw

Thanks for considering a contribution! OpenClaw aims to be a clean, free,
local-first AI assistant that Just Works. These guidelines keep the project
approachable and maintainable.

## Quick start

```bash
git clone <this-repo>
cd openclaw
npm install
npm run dev           # auto-reloads on file changes
# open http://localhost:3000
```

## Adding a new skill

Every skill is a single file in `skills/` named `my-skill.skill.js`:

```js
export default {
  name: 'my_skill',
  description: 'Clear, one-sentence description shown to the LLM.',
  parameters: {
    type: 'object',
    properties: { arg: { type: 'string' } },
    required: ['arg'],
  },
  async run(args, ctx) {
    // ctx = { workspaceDir, memory, logger, requestId }
    return { result: 'anything-json-serializable' };
  },
};
```

The skill is auto-loaded at boot and exposed to the agent tool-calling loop.

### Skill guidelines

- **Describe, don't instruct.** The `description` is injected into the
  model's tool catalog. Say what the tool does; the system prompt in
  `lib/brain.js` already tells the model when to use tools.
- **Return structured JSON** so the agent can reason about results. If an
  error happens, return `{ error: "why" }` instead of throwing when it's a
  user-facing mistake (e.g. bad URL). Throw for real bugs.
- **Keep side effects bounded.** All writes must go through `ctx.workspaceDir`
  or `ctx.memory`.
- **Security.** External HTTP calls must go through `safeFetch` (see
  `lib/safe-fetch.js`) which blocks private addresses.

## Adding a provider

Edit `lib/providers.js`. Three formats are supported: `openai` (most modern
APIs), `gemini`, `cohere`, and `huggingface`. Local providers should set
`local: true` and will be probed automatically.

## Adding a messaging adapter

Create `adapters/<name>.js`. It should export a `start(opts)` function that
takes `{ endpoint, logger, ... }`. Wire it into `startAdapters()` in
`server.js` with an env-var gate (so it only runs when the user opts in).

## Code style

- Modern ESM (`"type": "module"`).
- Two-space indentation.
- No framework-specific magic: plain Express + `fetch` + ESM.
- Favor small, single-purpose files over large ones.
- Comments explain *why*, not *what*.

## Tests

There isn't a test suite yet — the smoke test for now is:

```bash
curl http://localhost:3000/api/health
curl -X POST http://localhost:3000/api/agent \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Calculate 15 * 23"}]}'
```

If you want to add a proper test suite (Vitest preferred), that's a very
welcome contribution.

## Pull requests

- Branch from `main`.
- Keep PRs focused — one feature or fix per PR.
- Update the README if you change user-visible behavior.
- The repository is MIT-licensed; by contributing you agree to release your
  changes under the same license.
