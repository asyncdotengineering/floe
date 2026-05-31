# OpenAI-Compatible API

Floe exposes a drop-in OpenAI HTTP surface. Any tool that speaks `POST /v1/chat/completions` (the official OpenAI SDK, LangChain, LlamaIndex, AI SDK, Cursor, OpenWebUI, Continue, etc.) can point its `baseURL` at a Floe deployment and use it.

Your Floe value-adds (triage, flows, procedures, validators, memory, RAG) ride along invisibly.

## Quick start

```ts
import { Floe } from '@floe/runtime';
import { openaiCompat } from '@floe/runtime/openai-compat';

// ...build your Floe instance with conversations/agents/etc.

const handler = openaiCompat({
  floe,
  channel: 'web',
  defaultConversation: 'support',
  embedder, // optional — enables /v1/embeddings route
  authorize: (req) => req.headers.get('authorization') === `Bearer ${process.env.FLOE_API_KEY}`,
});

// Use anywhere fetch handlers work:
//   Node + Hono:
//     import { serve } from '@hono/node-server';
//     serve({ fetch: handler, port: 3000 });
//   Cloudflare Workers:
//     export default { fetch: handler };
//   Native Node http:
//     wrap with hono-node-server or similar
```

## Routes

| Method | Path | What it does |
|---|---|---|
| GET | `/v1/models` | Lists `floe/<conversation>` and `floe/<conversation>@<agent>` model IDs |
| POST | `/v1/chat/completions` | Runs a Floe turn. Supports streaming SSE + non-streaming JSON. |
| POST | `/v1/embeddings` | Proxies your configured `Embedder`. Returns OpenAI-shaped vectors. |

All routes also respond at the un-prefixed path (`/models`, `/chat/completions`, `/embeddings`) for clients that strip `/v1`.

## Model field mapping

| Client `model` | Floe routing |
|---|---|
| `"floe/support"` | Conversation `support`, normal triage |
| `"floe/support@sales"` | Conversation `support`, pin to agent `sales` (no triage) |
| `"support"` | Bare conversation name shortcut |
| `"auto"` or `"floe/auto"` | First-registered conversation |

## Using from the OpenAI SDK

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.FLOE_API_KEY,
  baseURL: 'https://your-floe-deployment.example.com/v1',
});

const completion = await client.chat.completions.create({
  model: 'floe/support',
  messages: [{ role: 'user', content: 'How much is the Pro plan?' }],
  user: 'alice', // becomes Floe userId for memory scoping
});
console.log(completion.choices[0].message.content);
```

Same code works with streaming:

```ts
const stream = await client.chat.completions.create({
  model: 'floe/support',
  messages: [{ role: 'user', content: 'Tell me about your refund policy' }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}
```

## Using from LangChain

```ts
import { ChatOpenAI } from '@langchain/openai';

const llm = new ChatOpenAI({
  apiKey: process.env.FLOE_API_KEY,
  configuration: { baseURL: 'https://your-floe-deployment.example.com/v1' },
  modelName: 'floe/support',
});
```

## Using from the Vercel AI SDK

```ts
import { createOpenAI } from '@ai-sdk/openai';

const floeProvider = createOpenAI({
  baseURL: 'https://your-floe-deployment.example.com/v1',
  apiKey: process.env.FLOE_API_KEY,
});

// Now use this in any AI SDK function
const result = await generateText({
  model: floeProvider('floe/support'),
  prompt: 'How can I help?',
});
```

## Authentication

Pass an `authorize` callback that inspects the incoming `Request`. Return `true` to allow, `false` to reject with 401. The OpenAI convention is `Authorization: Bearer <api-key>`:

```ts
openaiCompat({
  floe,
  authorize: (req) => {
    const auth = req.headers.get('authorization');
    if (!auth?.startsWith('Bearer ')) return false;
    const key = auth.slice(7);
    return key === process.env.FLOE_API_KEY;
  },
});
```

For multi-tenant deployments, route from the `Authorization` header to a per-tenant Floe instance — the handler is a per-instance object, so spin up a Map of instances and dispatch.

## What's NOT supported

- **Client-provided `tools`** — Floe's tools are registered at conversation-init time for security/DX. Requests that include `tools` with `tool_choice !== "none"` get a 400. Pass `tool_choice: "none"` to silently ignore client tools, or remove the `tools` array.
- **Vision input** — text only in v1.
- **`logit_bias`, `seed`, `response_format`** — parsed but not acted on.
- **`n > 1`** — Floe returns a single choice.
- **Audio routes (`/v1/audio/*`)** — out of scope; this surface is text-only.

## Session continuity

OpenAI's protocol is stateless — clients re-send the full message history each request. Floe stores its own session state per session id, which we derive from:

1. `metadata.sessionId` on the request body (preferred — explicit and stable)
2. `user` field on the request (stable per user, but shared across user's sessions)
3. A hash of the first user message (anon fallback)

Recommended for production: always pass `metadata: { sessionId: '<your-stable-id>' }` so multi-turn state is preserved exactly how you want it.

## Cost / latency reporting

OpenAI's `usage` block is filled with conservative token estimates (chars/4) when the underlying provider doesn't return per-call usage. For ground-truth metrics, attach an observability sink:

```ts
import { consoleSink, sentrySink } from '@floe/runtime/observability';

const floe = new Floe({
  defaults: {
    model: 'google/gemini-3.1-flash-lite',
    observability: { sinks: [consoleSink(), sentrySink({ client: Sentry })] },
  },
});
```

The sinks see real per-turn `TurnMetrics` including model, cost, per-stage latency, and token counts.

## Embedding from the OpenAI SDK

```ts
const embedding = await client.embeddings.create({
  model: 'text-embedding-3-small',
  input: 'Hello world',
});
```

The `model` parameter on this route is informational — your configured `Embedder` instance handles the request regardless of model name.

## Limits

Floe's OpenAI handler is a thin shim — it doesn't add its own concurrency limit. Rate limiting belongs in your Floe config:

```ts
import { tokenBucketRateLimit } from '@floe/runtime/reliability';

new Floe({
  defaults: {
    model: '...',
    rateLimit: tokenBucketRateLimit({ capacity: 20, refillPerSec: 1 }),
  },
});
```
