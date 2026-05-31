# Building a customer support bot with Floe

A layered blueprint, from minimum viable to production. The exact shape of `examples/ecommerce-bot/` — that example is the reference implementation of everything below.

The layers are additive: you can ship after Layer 0 and have something that works, then add the rest in order of where you are in the product lifecycle. Don't try to build all of it at once.

---

## Layer 0 — Minimum viable (≈30 minutes to first working turn)

```ts
// floe.config.ts
import { Assistant } from '@floe/runtime';
import { localSandbox } from '@floe/runtime/sandbox/local';
import { consoleSink } from '@floe/runtime/observability';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export default new Assistant({
  name: 'support',
  mode: 'direct',
  configDir: process.env.FLOE_WORKSPACE_ROOT
    ?? dirname(fileURLToPath(import.meta.url)),
  systemPrompt: 'You are the Acme support concierge.',
  model: process.env.FLOE_MODEL ?? 'openai/gpt-4.1-mini',
  thinkingLevel: 'off',
  sandbox: localSandbox(),
  observability: { sinks: [consoleSink({ format: 'pretty' })] },
});
```

```ts
// server.ts
process.env.PI_CACHE_RETENTION ??= 'long';

import { serve } from '@hono/node-server';
import { webAdapter } from '@floe/adapter-web';
import { openaiCompat } from '@floe/runtime/openai-compat';
import assistant from './floe.config.ts';

const floe = webAdapter({ assistant });
const openai = openaiCompat({ assistants: [assistant] });

const OPENAI = new Set([
  '/v1/chat/completions', '/chat/completions',
  '/v1/models', '/models',
]);

serve({
  fetch: (req) => {
    const p = new URL(req.url).pathname;
    return OPENAI.has(p) ? openai(req) : floe.fetch(req);
  },
  port: 3000,
  serverOptions: { requestTimeout: 0 },
});
```

You now have a working bot with two HTTP surfaces, both speaking canonical OpenAI Chat Completions SSE:

- `POST /agents/web/<sessionId>` for your own chat UI / mobile / web client
- `POST /v1/chat/completions` for Vapi, ElevenLabs, LiveKit, or any OpenAI SDK client

`PI_CACHE_RETENTION=long` is set at process boot — the static prompt prefix gets cached by the provider for 1 hour, so the 2nd+ turn in a session is significantly cheaper and faster.

---

## Layer 1 — Rules of engagement that survive every turn

Write `AGENTS.md` next to `floe.config.ts`. This is the file Floe auto-loads via `loadProjectContext(configDir)` and prepends to the system prompt on every turn (agents.md pattern, validated by Vercel at +47pp over tool-gated alternatives — see [their eval write-up](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals)).

```markdown
# Acme support — runtime context

You are the Acme support concierge. Apparel only.

## Tone

Warm, brief, decisive. One short reply per turn. Plain prose — no
markdown bullets, no asterisks, no emoji.

## What you NEVER do

- Promise prices, ship dates, or stock not in the # Reference material.
- Discuss anything outside Acme catalog or policies.
- Echo back PII (emails, phone numbers). Redacted before you see them.

## Hard rules

- Currency: USD with `$` prefix.
- Order IDs: `ord_NNNN` verbatim.
- Standard shipping: $7 flat, 5–7 business days. Express: $18.
- Return window: ≤30 days = full refund; 31–90 = 50% store credit;
  >90 = denied (offer escalate or $25 store credit on defect).
- Never invent products. If catalog doesn't include something, say
  "I don't see that in our current catalog."
```

Keep this file under 100 lines. It lives in the cached system prompt prefix — providers cache it across turns. Write **hard rules**, not soft preferences. The model already knows how to be polite; it doesn't know your loyalty math.

---

## Layer 2 — Structured tasks via flows

Every multi-step support task (return, refund, track-order, account change) goes in `flows/`. Use the 4 node kinds — see `docs/FLOWS.md` for full detail:

- **Extraction** — collect typed fields from the user, loops if needed.
- **Capture** — single-shot yes/no/classify on one message.
- **Compute** — deterministic business logic, NO LLM (math, lookups, side effects).
- **Reply** — produce user-facing text with strict output rules.

```ts
// flows/return.ts
import {
  defineExtractionNode, defineComputeNode, defineCaptureNode,
  defineReplyNode, defineFlow,
} from '@floe/runtime';
import * as v from 'valibot';

let lookupOrder, askConfirm, capture, processRefund,
    refundDone, returnDeclined, explainDenial;

const collect = defineExtractionNode({
  name: 'collect-order',
  prompt: 'Collect orderId (ord_NNNN) and a short reason.',
  schema: v.object({ orderId: v.string(), reason: v.string() }),
  requiredFields: ['orderId', 'reason'],
  async onComplete({ orderId, reason }, ctx) {
    ctx.state.orderId = orderId;
    ctx.state.reason = reason;
    return { kind: 'node', node: lookupOrder };
  },
});

lookupOrder = defineComputeNode({
  name: 'lookup-order',
  compute(ctx) {
    const order = ORDERS[ctx.state.orderId];
    if (!order) return { kind: 'end', reason: 'order not found' };
    const e = computeReturnEligibility(order.totalUsd, order.ageDays);
    ctx.state.refundAmountUsd = e.refundAmountUsd;
    if (!e.eligible) return { kind: 'node', node: explainDenial };
    return { kind: 'node', node: askConfirm };
  },
});

// askConfirm → Reply (asks "Shall I process the $189 refund?")
// next turn → Capture (yes/no) → branch:
//   confirmed → Compute (processReturnTool) → Reply ("Done — rtn_xyz")
//   declined  → Reply ("No problem.")

export const returnFlow = defineFlow({
  name: 'return',
  description:
    'Triggered when a customer asks to return, refund, or send back ' +
    'an item from a specific order.',
  startNode: () => collect,
});
```

Wire flows into the Assistant:

```ts
new Assistant({
  // …existing fields
  flows: [returnFlow, trackOrderFlow, /* … */],
});
```

The runtime auto-generates an `enter_<flow_slug>` tool the LLM calls when the user expresses the matching intent. Multilingual by construction — no regex hints in the description.

---

## Layer 3 — Knowledge (RAG, the agents.md way)

Two kinds of content:

### Procedures — policy bodies the assistant should reference

Live in `procedures/*.md`, registered:

```ts
new Assistant({
  // …
  procedures: [returnPolicyProc, escalationPolicyProc],
});
```

The runtime activates them by name when relevant; they land in the system prompt.

### Knowledge sources — RAG over your KB

Use the hybrid (BM25 + embeddings) for FAQ / policy docs:

```ts
import { hybridKnowledge } from '@floe/runtime/knowledge/hybrid';
import { openaiEmbedder } from '@floe/runtime/embedders/openai';
import { InMemoryVectorStore } from '@floe/runtime/vectorstores';

const embedder = openaiEmbedder({
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'text-embedding-3-small',
  dimensions: 256,
});

new Assistant({
  // …
  knowledge: [
    hybridKnowledge({
      name: 'policies-kb',
      paths: ['knowledge/policies/**/*.md', 'knowledge/faqs/**/*.md'],
      embedder,
      vectorStore: new InMemoryVectorStore({ dimensions: 256 }),
    }),
  ],
});
```

**Never expose retrieval as an LLM-decided tool.** Vercel's data: 56% non-invocation when capabilities are tool-gated. Floe auto-retrieves every turn; the chunks land in the system prompt under `# Reference material` with hardened cite-or-ignore rules baked in. The model decides per turn whether they're relevant.

---

## Layer 4 — Persona for tone (without rewriting the system prompt per environment)

```ts
new Assistant({
  // …
  persona: {
    voice: 'warm, professional',
    tone: 'patient, decisive',
    register: 'casual',
    avoidPhrases: ['unfortunately', 'I apologize for the inconvenience'],
  },
});
```

Renders as a `# Persona` block in the system prompt. Decouples tone tuning from the `systemPrompt` field; different deployments (staging, production, white-label) can override persona without rewriting your prompt.

---

## Layer 5 — Cross-session memory (remember what the customer told you)

```ts
import { VectorStoreMemoryService } from '@floe/runtime/memory';

new Assistant({
  // …
  memory: {
    service: new VectorStoreMemoryService({
      embedder,
      vectorStore: memoryVectorStore, // shared with knowledge or separate
      namespace: 'preferences',
    }),
    preload: { maxTokens: 600, namespace: 'preferences' },
    ingest: { auto: true, namespace: 'preferences' },
  },
  resolveUserId(input) {
    if (input.type !== 'user_text_sent') return undefined;
    const u = input.metadata?.userId;
    return typeof u === 'string' && u.length > 0 ? u : undefined;
  },
});
```

When the user says "I prefer the Forest colorway, size M in jackets," it auto-ingests. Next session (same userId), it preloads as context. The assistant remembers.

---

## Layer 6 — Validators (the right defaults)

```ts
import { piiRedaction, safety, groundedness } from '@floe/runtime/validators';

new Assistant({
  // …
  validators: [
    piiRedaction({ phase: 'preLLM', strategy: 'mask' }),
    // safety + groundedness default to phase: 'postLLM-async' now.
    // They run as a side channel AFTER the response stream closes —
    // user-facing latency unaffected, verdicts on the observability sink.
    safety(),
    groundedness(),
  ],
});
```

- `piiRedaction` is preLLM and regex-based — 1 ms, safe to leave synchronous.
- `safety` and `groundedness` are LLM-backed but now async by default — they add zero to your wire close time. Verdicts land on observability; you can re-prompt on failure if you want, but the user already got their reply.

Opt back into synchronous safety rewrite only when you genuinely need it (e.g., high-risk regulated content):

```ts
safety({ phase: 'postLLM' }) // adds ~1–2 s to wire close
```

---

## Layer 7 — Prelude (TTFT to ~5 ms)

```ts
new Assistant({
  // …
  prelude: 'Got it — one sec… ',
});
```

Buffer-words pattern. Emitted as the FIRST OpenAI `content` chunk on the wire, before retrieval / LLM even kick off. Voice TTS plays it while RAG + LLM run; the real reply appends as subsequent deltas on the same stream. Users perceive instant response.

For contextual filler, a thunk:

```ts
prelude: async (ctx) => {
  // Fast model returns a contextual ack in ~290 ms
  return ctx.prompt(
    `One short acknowledgement (≤8 words) of: ${ctx.userMessage}`,
    { model: 'openai/gpt-4.1-mini', maxTokens: 12 },
  );
},
```

Same wire shape, more relevant filler. End with `"… "` (ellipsis + space) for natural TTS prosody — the next deltas append seamlessly.

---

## Layer 8 — Durable state (don't lose mid-flow on cold starts)

```ts
import { createClient } from '@libsql/client';
import {
  libsqlAssistantStateStore, libsqlSessionStore, libsqlTranscriptStore,
} from '@floe/state-libsql';

const client = createClient({
  url: process.env.STATE_TURSO_URL!,
  authToken: process.env.STATE_TURSO_AUTH_TOKEN,
});

new Assistant({
  // …
  state: {
    sessionStore: libsqlSessionStore({ url: ... }),
    assistantStateStore: libsqlAssistantStateStore({ url: ... }),
    transcriptStore: libsqlTranscriptStore({ url: ... }),
  },
});
```

Required for serverless deployments (Vercel Lambda, Cloudflare Workers). Without it, the user's mid-flow state evaporates on every cold start — they'd have to restart the return flow if their request happened to hit a fresh container.

---

## Layer 9 — Runtime choice (where to run it)

Per `docs/LATENCY.md`:

- **Chat-only**: any serverless works (Vercel, Cloudflare). Cold starts are visible but tolerable.
- **Voice (Vapi / ElevenLabs / LiveKit calling `/v1/chat/completions`)**: warm-pool runtime required. Lambda's 5–11 s cold init blows the 800 ms voice budget. Use Fly, Render, Railway, or Cloudflare Containers.

---

## What you don't need to think about

These are shipped defaults — they work right out of the box, no configuration needed:

- **Streaming protocol** — canonical OpenAI Chat Completions SSE by default, both surfaces. Voice platforms and OpenAI SDK clients both just work.
- **`shouldRetrieve` gates / regex predicates** — don't write them. Floe always retrieves; prompt-baked positive AND negative rules in `# Reference material` decide relevance per turn. No surface-form fragility.
- **Double-wrapping the system prompt** — gone. Floe's composed prompt lands in the actual system message slot (cache-friendly) via the atomic `floePrompt(...)` helper.
- **`<system>…</system>` shadow tags in user messages** — gone.
- **Voice-specific code paths** — there aren't any. The defaults work for voice; if they meet that bar, chat is fast too.

---

## Order I'd build in for a real customer support bot

1. **Layer 0 + Layer 1** (Assistant + `AGENTS.md` + mount both adapters). One working turn end-to-end. Tested manually with `curl` against both surfaces.
2. **Layer 3** (knowledge for your FAQ / policy KB). Confirm one real RAG-grounded answer cites a chunk.
3. **Layer 2** (one flow — usually `return` or `track-order`, whichever is your highest-volume support task). Tested end-to-end across the multi-turn happy path AND the denial branch.
4. **Layer 4 + Layer 6 + Layer 7** (persona, validators, prelude). Production polish.
5. **Layer 5** (memory) — adds real value once you have repeat customers.
6. **Layer 8** (durable state) — required before going to prod on serverless.
7. More flows as you find more deterministic-policy tasks. The pattern repeats.

---

## What `examples/ecommerce-bot/` shows

That example IS this blueprint, fully wired. Walk it top-down to see every primitive in context:

| file                             | role                                                 |
| -------------------------------- | ---------------------------------------------------- |
| `floe.config.ts`                 | The Assistant — wires every primitive                |
| `AGENTS.md`                      | Runtime context (rules of engagement)                |
| `agents/concierge.ts`            | The `systemPrompt` field + persona definition        |
| `flows/return.ts`                | Canonical 4-node flow walkthrough                    |
| `flows/track-order.ts`           | Simpler Extraction → Compute → Reply flow            |
| `procedures/*.md`                | Markdown policies, activated by name                 |
| `knowledge/policies/*.md`        | Shipping / loyalty / warranty FAQs (hybrid RAG)      |
| `lib/orders.ts`                  | Mock orders table the flows look up against          |
| `server.ts`                      | Node entrypoint (mounts both adapters)               |
| `api/build-entry.ts`             | Vercel Lambda entrypoint (esbuild target)            |
| `test/bench.test.ts`             | 9-scenario eval framework, benched on 2 models       |

And the supporting docs you'll want open while building:

- `docs/FLOWS.md` — every node kind, worked examples, common shapes, pitfalls
- `docs/LATENCY.md` — performance budgets + the dials you can turn
- `docs/RAG.md` — knowledge sources in depth
- `docs/OBSERVABILITY.md` — wiring metrics, traces, console output
- `implementation-notes.md` — every architectural decision in this codebase, with the why

That's the whole blueprint. Build it in the order above; you'll have a production-grade support bot.
