# Acme Threads — Floe example

A complete customer-facing assistant exercising every Floe primitive. Not a
toy — the same wiring patterns scale to production.

## What it demonstrates

- **One assistant** (`support`) with `mode: 'direct'` — LLM triage decides
  per turn which flow to enter (no separate triage round-trip).
- **Three flows** (`purchase`, `return`, `track-order`) — each is a graph
  of the four node kinds (Extraction, Capture, Compute, Reply) per
  `docs/FLOWS.md`. The return flow is the canonical worked example —
  confirmation gate before side-effect, branching on deterministic policy
  math.
- **Two procedures** (return-policy, escalation-policy) — markdown content
  the assistant activates by name when relevant.
- **Hybrid RAG** — BM25 + OpenAI embeddings + InMemory vector store over
  the product catalog + policy/FAQ markdown.
- **Cross-session memory** — `preferences` namespace via the
  `VectorStoreMemoryService`. The assistant remembers things like "I
  prefer the Forest colorway, size M in jackets" across sessions.
- **PII redaction** (preLLM) + **safety** (postLLM-async, default) +
  **groundedness** (postLLM-async) validators.
- **Observability** — console sink in pretty format. Real per-turn
  latency breakdown by stage.
- **Eval framework** — 9 declarative scenarios bench-tested against
  Gemini 3.5 Flash (low thinking) and GPT-4.1-mini.

## What ships in the system prompt

Two pieces:

1. **`agents/concierge.ts`** — the `systemPrompt` field on the Assistant.
   Code-controlled. The Acme Threads identity + the high-level rules of
   engagement.
2. **`AGENTS.md`** — file-controlled runtime context loaded by
   `loadProjectContext(configDir)` and prepended as `# Project context` in
   every turn's prompt. Hard rules that travel with the project (currency
   format, ID formats, loyalty math, return window).

Both share the same cached prompt prefix — provider prompt-cache
(`PI_CACHE_RETENTION=long` on this app) means the LLM only pays for the
prefix on the first turn within the 1-hour window.

## Running locally

```bash
# Single source of truth — esbuild bundles api/build-entry.ts to api/handler.mjs
# for Vercel. server.ts runs the same Assistant on Node directly.

pnpm dev           # boots server.ts on PORT=3000 (default)
pnpm test:bench    # spawns the server per model and runs the 9-scenario eval
pnpm seed:catalog  # populates the local catalog.db (Turso-compatible libsql)
```

Two mounted surfaces:

- `POST /agents/web/<sessionId>` — Floe-native session semantics for chat UIs.
- `POST /v1/chat/completions` — OpenAI-compatible for voice platforms (Vapi,
  ElevenLabs, LiveKit) and any OpenAI SDK client. Same canonical wire
  underneath.
- `GET /history/<sessionId>` — the transcript store readback (libsql-backed
  in prod via `STATE_TURSO_URL`).

## File map

| path                       | role                                                |
| -------------------------- | --------------------------------------------------- |
| `floe.config.ts`           | The Assistant — wires every primitive               |
| `AGENTS.md`                | Runtime context (this lands in the system prompt)   |
| `agents/concierge.ts`      | The `systemPrompt` field + persona                  |
| `flows/return.ts`          | Canonical 4-node flow walkthrough                   |
| `flows/track-order.ts`     | Extraction → Compute → Reply, one shot              |
| `flows/purchase.ts`        | Recommendation flow                                 |
| `procedures/*.md`          | Markdown policies, activated by name                |
| `knowledge/policies/*.md`  | Shipping / loyalty / warranty FAQs (hybrid RAG)     |
| `knowledge/faqs/*.md`      | Common questions                                    |
| `lib/orders.ts`            | Mock orders table for the return + track-order flows|
| `lib/catalog.ts`           | Local catalog SQLite + product entries              |
| `server.ts`                | Node entrypoint                                     |
| `api/build-entry.ts`       | Vercel Lambda entrypoint (esbuild target)           |
| `test/bench.test.ts`       | 9-scenario eval framework                           |

## Environment

Read from `~/.env` at the repo root (or wherever the deployment platform
sets them):

| var                         | purpose                                         |
| --------------------------- | ----------------------------------------------- |
| `OPENAI_API_KEY`            | Embeddings + GPT-4.1-mini for the LLM           |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Gemini 3.5 Flash for the LLM                 |
| `STATE_TURSO_URL`           | Durable session/memory/transcript store (libsql)|
| `STATE_TURSO_AUTH_TOKEN`    | ditto                                           |
| `PI_CACHE_RETENTION`        | Defaulted to `long` in server.ts / build-entry  |
| `FLOE_MODEL`                | Override the default model (e.g. for the bench) |
| `FLOE_THINKING`             | Override thinking level (`off`/`low`/...)       |

`STATE_TURSO_URL` is optional — without it, sessions live in Lambda RAM
and reset on cold-start (fine for local dev, breaks mid-flow continuity
in serverless).
