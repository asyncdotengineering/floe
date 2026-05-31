# Floe Studio

A thin, clone-and-go chat UI for **any Floe agent**. Tanstack Start
(React + Vite) + Vercel AI SDK (`useChat`) + AI-Elements-style
components. Server-side proxy bridges to the agent's openai-compat
endpoint with in-memory **resumable streams** so a page refresh
mid-response picks up where it left off.

Think of it as the Mastra-Dev-Studio / Agno-UI equivalent for Floe:
a separate app you point at any running Floe template (`ops-bot`,
`chief-of-staff`, etc.) without bundling agent code into the UI.

## Quick start

```sh
# From the floe monorepo root:
pnpm install
cp apps/studio/.env.example apps/studio/.env
# Edit apps/studio/.env: set FLOE_AGENT_URL to the running template
# e.g. FLOE_AGENT_URL=http://localhost:3150  (chief-of-staff)

# In one terminal, run any Floe template:
pnpm --filter chief-of-staff dev

# In another, run Studio:
pnpm --filter @floe/studio dev
# → opens at http://localhost:3700
```

You're now chatting with the agent via the UI.

## How it works

```
┌────────────┐     POST /api/chat            ┌──────────────────┐
│  Browser   │ ───────────────────────────▶  │ Studio proxy     │
│            │     {messages, sessionId}     │ (TanStack Start  │
│  useChat   │                                │  server route)   │
│            │     AI SDK Data Stream         │                  │
│            │ ◀──────────────────────────── │                  │
└────────────┘                                │                  │
                                              │  ⇣ streamText +  │
                                              │  @ai-sdk/openai  │
                                              │                  │
                                              │  POST            │
                                              │  /v1/chat/       │
                                              │  completions     │
                                              │     ⇣            │
┌─────────────────────────────────────────────┴──────────────────┐
│  Floe agent (any template) — `openaiCompat: true`              │
│  http://localhost:31x0  (ops-bot, hearth, cedar, etc.)         │
└────────────────────────────────────────────────────────────────┘
```

**Key design**: the UI is **template-agnostic**. It speaks the openai-
compat wire that every Floe template ships. Point it at any agent URL
and it just works — no agent code inside the UI.

## Session id threading

The browser mints a stable `sessionId` (localStorage) and includes it
in the request body. The proxy passes it as the openai-compat `user`
field; Floe's `deriveSessionId` (`packages/runtime/src/openai-compat/
handler.ts:282`) maps it to `oai:<sessionId>`. Across turns from the
same browser tab, Floe sees the same session id and your conversation
state persists.

**New conversation** button → mints a fresh sessionId + reloads.

## Resumable streams

Each chat response is wrapped in a tiny in-memory registry
(`src/lib/stream-registry.ts`, ~80 LOC). The POST `/api/chat` response
includes an `x-resume-stream-id` header; the browser stashes it in
localStorage. If the connection drops (page refresh, network hiccup)
while a response is still streaming, the client can hit
`GET /api/stream/:streamId` to replay buffered chunks and continue
from where it left off.

The registry holds streams for 5 minutes after completion (GC window
for late refreshers), then drops them.

**Single-process only.** This in-memory version works in dev and for
single-replica deployments. For serverless / multi-replica:

```sh
pnpm add resumable-stream redis
```

Then swap `src/lib/stream-registry.ts` for the Vercel
[`resumable-stream`](https://github.com/vercel/resumable-stream)
package with Redis pubsub. The route-handler API stays identical —
`registerStream(id, source)` → `createNewResumableStream(id, () =>
source)`, `resumeStream(id)` → `resumeExistingStream(id)`.

## Storage

**None.** No Postgres, no auth, no chat history on the server. Session
id lives in the browser's localStorage; messages are kept in memory
by `useChat`. This is by design — Studio is a UI shell. If you need
persistent chat history, wire your own store on the proxy route or
swap to the Floe assistant-state store on the agent side.

## Why not Vercel's chatbot template?

I considered forking [vercel/chatbot](https://github.com/vercel/chatbot)
but decided against it:
- 20k-star template, ~10× the code for what we need
- Auth.js + Drizzle + Postgres + Vercel Blob + @vercel/otel +
  @vercel/analytics + botid + codemirror + artifacts + instrumentation
- Stripping all that is more work than building fresh

Studio is intentionally minimal. The shape mirrors AI Elements
component APIs, so when you want polish you can run:

```sh
npx ai-elements@latest add conversation message response prompt-input
```

and the canonical Vercel components drop into
`src/components/ai-elements/` replacing the inline minimal versions
here.

## Why Tanstack Start (not Next.js)?

- File-based routing via Tanstack Router (type-safe end-to-end)
- Vite-powered dev server (fast HMR, no Next.js webpack costs)
- Server functions / API routes work the same way they do in Next
  App Router, but the framework itself is leaner
- No vendor lock-in to Vercel-specific primitives

The proxy route shape is portable — the `/api/chat` handler is just
a `POST` returning a `Response`. Migrating to any other React
framework (Next, Remix, etc.) is mostly a rename.

## Project layout

```
apps/studio/
├── package.json               — Tanstack Start + AI SDK + Tailwind v4
├── vite.config.ts             — tanstackStart + nitro + viteReact + tailwindcss
├── tsconfig.json
├── .env.example               — FLOE_AGENT_URL + cosmetic VITE_AGENT_NAME
├── src/
│   ├── router.tsx
│   ├── routes/
│   │   ├── __root.tsx
│   │   ├── index.tsx          — the chat page
│   │   └── api/
│   │       ├── chat.ts            — POST: streamText → Floe + register
│   │       └── stream.$streamId.ts — GET: resume an in-flight stream
│   ├── components/
│   │   ├── chat.tsx
│   │   └── ai-elements/       — minimal Conversation/Message/Response/PromptInput
│   ├── lib/
│   │   ├── cn.ts
│   │   ├── session.ts          — localStorage sessionId
│   │   └── stream-registry.ts  — in-memory resumable streams
│   └── styles/app.css          — Tailwind v4
└── README.md (you are here)
```

## What's NOT in v1

- **Chat history persistence** — `useChat` keeps messages in memory.
  Refreshing keeps the conversation context on Floe's side (memory
  preload), but the local message list resets. Wire your own store
  for persistent UI history.
- **Auth** — by design. If you need auth, add a Tanstack Start
  middleware on `/api/chat` (the chat route already supports the
  `middleware: []` array).
- **Markdown / code / math rendering** — the inline `Response`
  component renders plain prose. Run `npx ai-elements@latest add
  response` for the streamdown-powered markdown renderer.
- **Tool-call display, reasoning panels, artifacts** — AI Elements
  ships components for these. Run `npx ai-elements@latest add
  tool reasoning artifact` and wire them in chat.tsx.
- **Multi-agent UI** — Studio talks to ONE `FLOE_AGENT_URL`. For an
  agent selector, swap env-var lookup for a runtime config that the
  user picks from a dropdown.
