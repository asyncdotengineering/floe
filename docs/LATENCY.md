# Latency & Streaming

Floe targets the latency budget of a real-time voice agent as its **default bar** — not because everyone deploys voice, but because if the defaults meet that bar then chat, mobile, and embedded clients are fast too. There is no separate "voice mode." One wire, one encoder, one set of defaults.

This document records the budget, the streaming architecture, the measurements, and the dials.

---

## The budget — and why we adopted it

Source: [voiceaiandvoiceagents.com](https://voiceaiandvoiceagents.com/) — the reference latency breakdown for a real-time voice loop.

**End-to-end conversational latency target: 800 ms voice-to-voice.** The breakdown:

| stage                          | budget (ms) |
| ------------------------------ | ----------:|
| mic → encode → transport in    | ~115       |
| transcription + endpointing    | ~300       |
| **LLM time-to-first-token**    | **~350**   |
| TTS time-to-first-byte         | ~120       |
| transport out → decode → speaker | ~90      |
| **total**                      | **~975**   |

The LLM is allowed **~350 ms** before the first audible byte. The numbers that matter are **TTFT** and **per-token throughput** — not total response time. A reply that takes 4 s to generate is fine if the first token arrives in 350 ms and the rest streams into TTS sentence-by-sentence; a reply that takes 800 ms to finalize but **blocks the response until done** is broken.

Reference TTFTs from the source (May 2025):

| model                  | p50 TTFT | p95 TTFT |
| ---------------------- | -------:| -------:|
| GPT-4o-mini            |   290   |   420   |
| Gemini 2.0 Flash       |   380   |   450   |
| Llama 4 Maverick (Groq)|   290   |   360   |
| Claude Sonnet 3.7      | 1,410   | 2,140   |

Provider TTFT alone consumes most of the budget. Anything Floe adds before the LLM call eats into the ~50 ms safety margin.

---

## Architecture: one wire, one encoder

**Floe ships exactly one streaming protocol: OpenAI Chat Completions chunked SSE.** Every HTTP surface Floe mounts speaks it. There is no Floe-native event stream, no AI-SDK-specific protocol, no voice-specific format. The same wire serves Vapi, ElevenLabs, the OpenAI SDK, LangChain, AI SDK, Cursor, OpenWebUI, browser chat UIs, mobile clients, and every other consumer that already speaks "OpenAI."

### Why this and not alternatives

| candidate                                      | universality                       | richness                          | choice |
| ---------------------------------------------- | ----------------------------------| -------------------------------- | ------ |
| **OpenAI Chat Completions SSE chunks**         | every chat UI, voice platform, every OpenAI SDK | text + tool_calls               | ✅ canonical |
| Vercel AI SDK Data Stream Protocol (`text-delta`, `tool-call-input-delta`, …) | React `useChat`, Mastra, Vercel ecosystem | typed parts (text-delta, tool-call, reasoning, finish) | JS-only |
| Custom "Floe native" event stream              | Floe-aware clients only          | richest (runtime internals)      | leaks internals |

The reasoning: **OpenAI Chat Completions is the lingua franca**. Vapi and ElevenLabs both expect `POST /chat/completions` returning OpenAI SSE chunks (confirmed against [Vapi custom-LLM docs](https://docs.vapi.ai/customization/custom-llm/using-your-server.md) and [ElevenLabs custom-LLM docs](https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm.md)). Every chat UI built on the OpenAI SDK speaks the same format. AI SDK can consume OpenAI SSE via `streamText({ model: openai(...) })` — the Vercel ecosystem bridges *to* OpenAI, not the other way around. Custom protocols (Mastra's `text-delta`/`tool-call`/`reasoning-delta` chunks, the older "Floe native" event stream) lock the consumer into one ecosystem.

### What the wire carries

```
data: {"id":"chatcmpl-…","object":"chat.completion.chunk","created":…,"model":"floe/support",
       "choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-…","object":"chat.completion.chunk","created":…,"model":"floe/support",
       "choices":[{"index":0,"delta":{"content":"Got"},"finish_reason":null}]}

data: {"id":"chatcmpl-…","object":"chat.completion.chunk","created":…,"model":"floe/support",
       "choices":[{"index":0,"delta":{"content":" it — your order is "},"finish_reason":null}]}

…

data: {"id":"chatcmpl-…","object":"chat.completion.chunk","created":…,"model":"floe/support",
       "choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

Two delta kinds: `content` (text) and `tool_calls` (function invocations the model decided on). Finish reason is `stop` or `tool_calls`. That's it.

### What the wire deliberately doesn't carry

Floe's runtime emits a rich internal event stream — `thinking_delta`, `conversation_event` subtypes (knowledge_query, knowledge_hit, validator_result, …), `run_start`/`run_end`, `operation_start`, `agent_send_text`, `text`, `tool_start`, `idle`. **None of these reach the HTTP wire.** They are observability concerns:

- For your own service: configure an `observability.sinks` on the Assistant (`consoleSink`, `otelSink`, your custom sink).
- For benches and dev tools: opt in to `X-Floe-Debug-Events: 1` and read the single `event: floe.run\ndata: {events, state}\n\n` extension event that arrives before `[DONE]`. OpenAI SDK clients ignore named SSE events; this is invisible in production.

This is the discipline: **wire = what the user sees. Observability = how the system felt while delivering it.** Mixing them was the old design's tech debt.

### Two surfaces, one wire

Floe mounts two HTTP surfaces per Assistant. Both produce the identical wire — there is no second streaming code path to drift out of sync:

| URL                                  | adapter        | purpose                                       |
| ------------------------------------ | -------------- | --------------------------------------------- |
| `POST /agents/<channel>/<sessionId>` | `webAdapter`   | Floe-native session semantics (sessionId in path) for chat UIs / mobile / web clients |
| `POST /v1/chat/completions`          | `openaiCompat` | OpenAI-shaped (sessionId derived from `user` or `metadata.sessionId`) for voice platforms + every OpenAI SDK |
| `GET  /v1/models`                    | `openaiCompat` | Lists `floe/<assistant>` model ids            |
| `POST /v1/embeddings`                | `openaiCompat` | Optional, gated on `embedder:` option         |

Both adapters share the same lazy-cached `FloeApp` under the hood — mounting both is free.

### Content negotiation

The HTTP `Accept` header (and OpenAI's `stream` boolean) decide the response shape:

| caller request                              | response                                              |
| ------------------------------------------- | ----------------------------------------------------- |
| `Accept: text/event-stream` *(default)*     | OpenAI Chat Completions chunked SSE                   |
| `Accept: application/json`                  | One `chat.completion` JSON object (same content, buffered) |
| OpenAI `stream: true` *(default for voice)* | Same SSE                                              |
| OpenAI `stream: false`                      | Same JSON object                                      |

The buffered path runs the same mux to completion and aggregates the chunks. It's the degenerate case of streaming, not a separate implementation.

### Internals

`packages/runtime/src/streaming/`:
- `openai-encoder.ts` — pure functions: `encodeFlueEvent(evt, ctx) → OpenAIChunk | null`. The only place runtime events are translated. Drops every event that isn't `text_delta` (→ content) or `tool_call` with a real `name` (→ tool_calls). Defensive: internal Flue tool-bookkeeping events without a `name` are dropped, so the wire never carries ghost tool calls.
- `mux.ts` — `streamAsOpenAISSE(upstream, opts)` and `bufferAsOpenAIJson(upstream, ctx)`. Takes the upstream `Response` whose body is Flue's native SSE stream and re-shapes it. Both adapters call into this; there is no other streaming path.
- `index.ts` — barrel + small helpers (`newCompletionId`, `callerWantsBufferedJson`, `callerWantsDebugRunEvent`).

Tested in `packages/runtime/test/streaming-mux.test.ts` (18 tests): encoder translation, drop list, end-to-end wire shape, `tool_calls` finish reason, debug event opt-in, opt-out JSON buffering.

---

## Measurements

Bench: 9 scenarios × 2 models (Gemini 3.5 Flash low / GPT-4.1-mini), local server, OpenAI direct + Gemini direct, full pipeline including RAG + post-LLM validators.

### TTFT — what a user actually waits for

After the full default stack (canonical OpenAI SSE + RAG always-on with prompt-baked guidance + async safety + prompt cache + **AGENTS.md auto-load** + **prelude/buffer-words**):

| model                  | TTFT p50 | TTFT p95 | E2E p50 | tail (E2E − TTFT) p50 |
| ---------------------- | -------:| -------:| ------:| -------------------:|
| gpt-4.1-mini           | **5**   | ~10     | 2,084  | ~2,000              |
| gemini-3.5-flash (low) | **6**   | ~10     | 2,089  | ~2,000              |

**TTFT collapsed by 200–400×** vs the pre-prelude bench (gpt 1,421 → 5 ms; gemini 2,013 → 6 ms). The prelude lands as the first OpenAI `content` chunk within network-floor time; the real LLM tokens stream in as subsequent deltas while TTS plays the filler. The user perceives an instant response — voice budget hit by construction on every turn that defines a prelude.

E2E sits at ~2 s and is unchanged — that's the actual LLM generation + RAG. **The tail is now what the user doesn't see**: TTS is mid-sentence on the filler by the time the LLM's first real token arrives. One continuous spoken reply from the consumer's perspective.

Input tokens up ~40% (gpt 3,234 → 4,637, gemini 3,495 → 5,050) — the AGENTS.md content now lives in every prompt. Provider prompt cache (`PI_CACHE_RETENTION=long`) reclaims most of that cost on the 2nd+ turn within the 1-hour window.

### Per-stage breakdown (p50 across the bench run)

| stage              | p50 (ms) | p95 (ms) | what it is                                  |
| ------------------ | -------:| -------:| ------------------------------------------- |
| triage             | 0       | 0       | Flow routing classifier (off in direct mode)|
| knowledge          | 383     | 1,077   | RAG embed + vector search                   |
| memory preload     | 0       | 206     | User-pref vector lookup (only when bound)   |
| preLLM validators  | 0       | 1       | PII redaction (regex, fast)                 |
| prompt build       | 0       | 1       | System prompt + persona + tools assembly    |
| **LLM**            | **1,828** | 24,157 | The model call from request → finish        |
| **postLLM validators** | **1,877** | 5,937 | Safety + groundedness (LLM-backed)          |
| memory ingest      | 0       | 1       | Memory write-back                           |

Where the time goes:
- **~400 ms pre-LLM** is RAG embed + search.
- **~1,800 ms LLM** is the full reply. With streaming, the user perceives only the TTFT slice (~290–450 ms provider TTFT for the small models).
- **~1,900 ms postLLM** is safety + groundedness LLM-backed checks. **This is the largest hidden cost on a streaming response** — the wire stays open until validators finish.
- **Cold start on Vercel Lambda** was 11 s on first request. Serverless cold-init is voice-fatal.

---

## How to hit the budget

The defaults are tuned to be reasonable; the dials below are how you trade off correctness, cost, and latency.

### Always on (shipped defaults)

- **Streaming OpenAI Chat Completions SSE.** Default for every Floe HTTP surface. Don't request `Accept: application/json` unless you need the buffered envelope.
- **`thinkingLevel: 'off'` or `'low'`.** Reasoning modes add 500–2,000 ms before any user-visible token. Set `'off'` for the conversational surface; opt up only inside Compute/Capture nodes that need it.
- **Smallest competent model.** GPT-4.1-mini, Gemini-3.5-flash, Groq Llama 4 Maverick all sit in the 290–450 ms TTFT band. Avoid Claude Sonnet for the conversational brain (p50 ~1.4 s).
- **Knowledge is always retrieved and baked into the system prompt (agents.md pattern).** Floe never exposes retrieval as an LLM-decided tool — Vercel's data shows 56% non-invocation when capabilities are tool-gated. Instead, every turn's retrieved chunks land under `# Reference material` with explicit positive AND negative prompting: when to USE them, when to IGNORE them, never invent details, say "I don't have that" rather than guess. The LLM decides per turn whether the chunks are relevant. There is no developer-written `shouldRetrieve` heuristic — that pattern recreated the same surface-form fragility we eliminated elsewhere (regex on "size" vs "sizing", non-English failure, false negatives). When in doubt, retrieve; correctness comes from the prompt rules, latency from making RAG itself faster.
- **`AGENTS.md` and `CLAUDE.md` auto-loaded from `Assistant.configDir`** (the agents.md pattern Vercel's evals validate: +47pp over tool/skill alternatives, 100% on their benchmark suite). At Assistant boot, Floe reads both files once (module-cached in `project-context.ts`), and threads the concatenated content into every `buildSystemPrompt` call as `# Project context`. Same prompt-cache prefix as the rest of the system message; pays for itself on the 2nd turn forward.
- **Floe's composed system prompt lands in the actual system message slot — no shadow wrap.** Every Floe LLM call goes through `floePrompt({ session, systemPrompt, userMessage, options })`. One atomic helper. Internally it routes `systemPrompt` to the real system message slot (via a targeted `session.config.systemPrompt` mutation that Flue's `withScopedRuntime` reads on every prompt() call) and dispatches `userMessage` raw, no markup. The legacy pattern `session.prompt("<system>\n${ourPrompt}\n</system>\n\nUser: ${msg}", ...)` is gone — Floe's prompt content used to live in the user message body, which providers don't cache as a prefix. Now the system prefix is cacheable (`PI_CACHE_RETENTION=long` = 1 h TTL), and Reply nodes no longer see AGENTS.md twice. See `packages/runtime/src/orchestrator/floe-prompt.ts` for the full rationale and the upstream-fix narrative (one Flue PR adding `PromptOptions.systemPrompt` and the cast disappears).
- **Prelude / buffer-words filler.** Optional `prelude: string | (ctx) => string | Promise<string>` on the Assistant config. When set, Floe emits a synthetic `text_delta` BEFORE retrieval starts — translated through the canonical mux into the wire's first OpenAI `content` chunk. For a static string TTFT collapses to network floor (~5 ms in our bench, down from 1,400 ms). For a thunk, `ctx.prompt(...)` lets you call a fast model for a contextual filler ("Looking up order ord_2240…") in ~290 ms — still within voice budget, more useful than "one moment…". Voice TTS plays the filler while RAG + LLM run; the real reply appends as subsequent deltas on the same stream. The user hears one continuous sentence. End the filler with `"… "` (ellipsis + space) for natural prosody — the "buffer words" pattern.
- **`safety()` validator runs async by default** (`phase: 'postLLM-async'`). Verdicts land on the observability sink after the response stream closes; user-facing latency is unaffected. ~1.9 s saved from the wire tail. Opt back into synchronous-rewrite via `safety({ phase: 'postLLM' })` if you actually need pre-send sanitization.
- **`PI_CACHE_RETENTION=long`** set on process boot in the example app's `server.ts` + `api/build-entry.ts`. Extends Pi's underlying provider prompt-cache TTL from 5 min to 1 h. The static system prompt + persona + tool descriptions are identical every turn and should always be cached — 30–50% TTFT cut on repeat turns within the window. Free. No `.env` changes needed; the boot-time default uses `process.env.PI_CACHE_RETENTION ??= 'long'`.

### Cheap dials

- **Trim the system prompt.** Bench shows 3,000–5,000 input tokens per turn — most of which is system prompt + persona + tool descriptions. Provider TTFT scales roughly with input tokens for un-cached calls. Halving the prompt roughly halves TTFT.
- **Make RAG itself faster, don't gate it harder.** The agents.md pattern is right: chunks in the system prompt every turn, model decides relevance. The gate (`shouldRetrieve`) is only safe for structural skips (greetings, empty, flow-state). To actually cut p50 RAG cost: smaller embedder dimensions (we run 256 — try 128), a kNN cache on common queries, or fire embed + search **in parallel** with the first LLM call and inject chunks as a tool-result on a second turn if they arrive too late.

### Bigger dials

- **Detach post-LLM validators from the response.** Safety + groundedness LLM-backed checks add ~1,900 ms p50. For voice and most chat they should run on a background queue: response closes the wire, validators emit results to the observability sink (with re-prompting compensation if they fail). Floe does this for `phase: 'postLLM-async'` validators; move the synchronous ones over.
- **Run on a warm, long-lived process.** Vercel Lambda's 11 s cold start makes voice unusable. Fly, Render, Railway, Cloudflare Containers — any warm-pool runtime.
- **Co-locate region.** Floe → LLM provider → STT/TTS in the same region. Cross-region adds 100–150 ms per round trip.

### Architectural

- **Speak-while-computing.** When a flow enters a Compute node that takes >300 ms, emit a synthesized placeholder reply *immediately on flow entry*, then continue with the real reply once Compute completes. Voice guide calls this "buffer words."
- **Speculative parallelism.** Fire the LLM call while RAG retrieval is in flight; inject knowledge as a tool result once available.
- **Single tool per turn.** Disable parallel tool calling — the model commits to a fan-out before any tool can stream text. Single-tool turns let the model start speaking as soon as one tool result is ready.
- **Replace tool-call extraction with structured output.** Floe's `defineExtractionNode` today uses a `submit_X_data` tool the LLM must call (1 round-trip per extraction). Switching to `response_format: json_schema` lets the model emit fields and user-facing text in one call.

---

## Voice integration cookbook

Floe doesn't ship a voice adapter — voice platforms call the same `/v1/chat/completions` they already speak. The example app mounts both surfaces:

```ts
// server.ts
import { serve } from '@hono/node-server';
import { webAdapter } from '@floe/adapter-web';
import { openaiCompat } from '@floe/runtime/openai-compat';
import supportAssistant from './floe.config.ts';

const floe = webAdapter({ assistant: supportAssistant });
const openai = openaiCompat({ assistants: [supportAssistant] });

const OPENAI_ROUTES = new Set([
  '/v1/chat/completions', '/chat/completions',
  '/v1/models', '/models',
  '/v1/embeddings', '/embeddings',
]);

serve({
  fetch: (req) => {
    const path = new URL(req.url).pathname;
    return OPENAI_ROUTES.has(path) ? openai(req) : floe.fetch(req);
  },
  port: 3000,
  serverOptions: { requestTimeout: 0 },
});
```

Both adapters share the underlying lazy-cached `FloeApp` — no extra cost. Point Vapi or ElevenLabs at `<deployment>/v1/chat/completions` as their custom-LLM endpoint and they Just Work.

For sessionId routing on the OpenAI surface: pass `metadata.sessionId` in the request body, or use the `user` field (Floe derives a stable session id from it via `oai:<user>`).

---

## How to measure your own deployment

The bench in `examples/ecommerce-bot/test/bench.test.ts` consumes the SSE stream and reports both TTFT and end-to-end per scenario per model. To measure your own setup:

1. Wire `consoleSink({ format: 'pretty' })` into your `Assistant({ observability: { sinks: [...] } })`. You'll get one `latency total=Xms triage=Y knowledge=Z …` line per turn.
2. Send requests via `curl -N -H 'Accept: text/event-stream'`. Time the wall-clock between request POST and the first `data: {…"content":"…"…}` chunk — that's your TTFT.
3. For development assertions on flow state or runtime events: set `X-Floe-Debug-Events: 1` and parse the single `event: floe.run` SSE event before `[DONE]`. Never set this header in production traffic.

---

## Anti-patterns

- **Inventing a third streaming protocol.** Stick to the canonical wire. The mux is the only translation point; don't bypass it.
- **Leaking runtime events into the response body.** `thinking_*`, `conversation_event`, `run_start`, `run_end` are observability, not wire. The encoder drops them on purpose.
- **Synchronous post-LLM validators on user-facing replies.** They block the wire after the user already heard the reply. Async them unless you're willing to re-prompt on failure.
- **"Streaming is too complex; let's just buffer."** Buffered JSON loses 1.5+ seconds of perceived latency for zero functional benefit. The default is streaming; buffered is opt-in for legacy clients.
- **Running RAG on every turn.** Retrieval is the largest pre-LLM cost. Gate it on intent.
- **Claude Sonnet as the primary conversational brain.** Triple the TTFT of GPT-4.1-mini. Use it for hard reasoning inside Compute/Capture nodes, not the streaming Reply path.
- **Serverless cold starts.** Voice can't tolerate Lambda cold-init. Warm-pool runtime.
- **Parallel tool calls on a streaming reply.** Model commits to a fan-out before any tool can return text. Single tool per turn for voice.
- **Long thinking budgets on conversational turns.** `'medium'` / `'high'` add seconds before any user-visible token. `'off'` for the conversational path.
