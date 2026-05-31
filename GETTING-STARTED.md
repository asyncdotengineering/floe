# Getting Started with Floe

A 10-minute walkthrough. By the end you'll have a working agent that:

- Routes user messages to the right agent or flow
- Runs structured multi-step workflows with deterministic business logic
- Retrieves answers from a markdown knowledge base
- Logs per-turn metrics through a pluggable observability sink

The complete code lives in `examples/ecommerce-bot/`. This guide explains the shape and what to change to make it yours.

---

## 0. Prerequisites

- Node ≥ 22.18
- pnpm ≥ 9
- A model provider key — Floe ships against `pi-ai`'s model registry (Google, OpenAI, Anthropic, xAI, Groq, Cerebras, Together, Fireworks, …)

```bash
git clone … floe
cd floe
pnpm install
```

---

## 1. Project layout

```
your-app/
├── floe.config.ts        # ← the entry point. Builds + exports the Floe app.
├── server.ts             # Node deployment: serve({ fetch: floe.fetch })
├── agents/               # one defineAgent() per file
├── flows/                # one defineFlow() per file
├── procedures/           # markdown policies + their TS wrappers
├── knowledge/            # RAG sources (markdown, chunked at load time)
├── lib/                  # non-Floe shared modules (DB clients, mocks, helpers)
└── package.json
```

**No dot-folders.** No `.flue/agents/*`, no `.floe/index.ts`, no codegen. The app is plain TypeScript that you run with `tsx`.

---

## 2. The entry point

```ts
// floe.config.ts
import { createFloeApp, defineConversation } from '@floe/runtime';
import { webChat } from '@floe/runtime/channels/web-chat';
import { workspaceBm25 } from '@floe/runtime/knowledge/workspace-bm25';
import { groundedness } from '@floe/runtime/validators';
import { conciergeAgent } from './agents/concierge.ts';
import { refundFlow } from './flows/refund.ts';

const supportConvo = defineConversation({
  name: 'support',
  agents: [conciergeAgent],
  flows: [refundFlow],
  knowledge: [workspaceBm25({ name: 'help-center', paths: ['knowledge/**/*.md'] })],
  validators: [groundedness()],
});

export const floe = createFloeApp({
  conversations: { support: supportConvo },
  channels: { web: webChat },
  defaults: {
    model: 'google/gemini-3.5-flash',
    thinkingLevel: 'low',
  },
});

export default floe;
```

`createFloeApp(...)` returns `{ fetch, router, floe }`. The `fetch` is a Web-Standard `(req: Request) => Response` handler — mountable anywhere fetch runs.

---

## 3. Deploy

Pick the surface your target needs.

### Node — `tsx server.ts`

```ts
// server.ts
import { serve } from '@hono/node-server';
import floe from './floe.config.ts';

serve({ fetch: floe.fetch, port: Number(process.env.PORT ?? 3000) });
console.log('floe ready on :3000');
```

```bash
pnpm tsx server.ts
```

No build step. tsx runs TypeScript directly.

### Cloudflare Worker

```ts
// worker.ts
import floe from './floe.config.ts';
export default { fetch: floe.fetch };
```

Deploy with `wrangler deploy`. Same `floe.config.ts`.

### Vercel Edge Function

```ts
// api/[...all].ts
import floe from '../floe.config.ts';
export const config = { runtime: 'edge' };
export default (req: Request) => floe.fetch(req);
```

Deploy with `vercel deploy`.

### Mounted inside an existing Hono / Express app

```ts
import { Hono } from 'hono';
import floe from './floe.config.ts';

const api = new Hono();
api.route('/api/chat', floe.router);
api.get('/healthz', (c) => c.text('ok'));
export default { fetch: api.fetch };
```

Mount Floe under a subpath. Lets you bolt conversational AI onto an existing API without a separate process.

---

## 4. Define an agent

```ts
// agents/concierge.ts
import { defineAgent, defineTool } from '@floe/runtime';
import * as v from 'valibot';

const lookupAccount = defineTool({
  name: 'lookupAccount',
  description: 'Look up a customer account by email.',
  parameters: v.object({ email: v.string() }),
  async execute({ email }) {
    return { customerId: 'cus_123', plan: 'pro', status: 'active' };
  },
});

export const conciergeAgent = defineAgent({
  id: 'concierge',
  description:
    'Existing-customer support: billing, account changes, refunds, troubleshooting.',
  systemPrompt:
    'You are a calm, accurate support agent. Be concise. Always look up the account before answering account-specific questions.',
  tools: [lookupAccount],
});
```

The `description` is what the triage LLM sees — write it like a product spec, not a regex.

---

## 5. Define a flow

Flows are graphs where each node returns the next node from its handler — no static edges.

```ts
// flows/refund.ts
import { defineFlow, defineNode, defineTool } from '@floe/runtime';
import * as v from 'valibot';

let checkEligibility: ReturnType<typeof defineCheckEligibility>;
let askConfirmation: ReturnType<typeof defineAskConfirmation>;
let explainDenial: ReturnType<typeof defineExplainDenial>;

// Node 1 — silent (has `result`). LLM emits structured data, handler routes.
const collectInvoice = defineNode({
  name: 'collect-invoice',
  prompt: `Extract the invoice id (format inv_XXX) and the customer's stated reason from their message.`,
  result: v.object({ invoiceId: v.string(), statedReason: v.string() }),
  async handler({ invoiceId, statedReason }, ctx) {
    ctx.state.invoiceId = invoiceId;
    ctx.state.statedReason = statedReason;
    return { kind: 'node', node: checkEligibility };
  },
});

// Node 2 — silent + tool. LLM ONLY captures raw tool output; math runs in code.
function defineCheckEligibility() {
  return defineNode({
    name: 'check-eligibility',
    prompt: `MANDATORY: call lookupInvoice with the invoice id. Capture the raw amountUsd and ageDays from the tool result.`,
    tools: [lookupInvoice],
    result: v.object({ amountUsd: v.number(), ageDays: v.number() }),
    async handler({ amountUsd, ageDays }, ctx) {
      const e = computeEligibility(amountUsd, ageDays);
      ctx.state.refundAmountUsd = e.refundAmountUsd;
      ctx.state.eligibilityReasoning = e.reasoning;
      if (!e.eligible) return { kind: 'node', node: explainDenial };
      return { kind: 'node', node: askConfirmation };
    },
  });
}

// Node 3 — text-producing (no `result`). The user sees this; the turn ends here.
function defineAskConfirmation() {
  return defineNode({
    name: 'ask-confirmation',
    prompt: `Tell the customer they're eligible for a refund of $\${refundAmountUsd} on invoice \${invoiceId}, and ask them to confirm.`,
    async handler() {
      return { kind: 'node', node: captureConfirmation };
    },
  });
}

export const refundFlow = defineFlow({
  name: 'refund',
  description: 'Multi-step refund: extract invoice, look up, compute eligibility, ask user, process.',
  startNode: () => collectInvoice,
});
```

### The single biggest production lesson

**Never let the LLM do business logic.** The model extracts structured data and produces natural language. Eligibility, money math, policy decisions — all of that lives in plain TypeScript inside the handler.

### Silent vs text-producing nodes

A node with a `result` schema is **silent** — the LLM emits a JSON object, the handler runs, control passes to the next node in the same turn. A node *without* a `result` schema produces **user-visible text** and the turn ends.

This is what lets a single user message flow through `collect-invoice → check-eligibility → ask-confirmation` and emit one well-formed reply. The orchestrator chains silent nodes up to depth 5.

---

## 6. Define a procedure (markdown)

```markdown
<!-- procedures/refund-policy.md -->
---
name: refund-policy
triggers: ["refund", "money back", "cancel"]
escalate-when: "customer threatens chargeback or legal action"
---

# Refund Policy

- Within 30 days: full refund.
- 31–90 days: 50% refund.
- Over 90 days: not eligible; offer store credit or escalate.

If the customer is upset, lead with empathy. Never promise something the policy doesn't grant.
```

Reference it:

```ts
// procedures/refund-policy.ts
import { defineProcedure } from '@floe/runtime';
export const refundPolicyProc = defineProcedure('procedures/refund-policy.md');
```

The first time a procedure activates in a session, the loader reads + parses the file and attaches the body to the LLM system prompt.

---

## 7. Knowledge retrieval

Two production knowledge sources ship in-box.

```ts
import { workspaceBm25 } from '@floe/runtime/knowledge/workspace-bm25';

const helpCenter = workspaceBm25({
  name: 'help-center',
  paths: ['knowledge/**/*.md'],
  chunkSize: 600,
});
```

Production BM25: `k1=1.5`, `b=0.75`, stopword filtering, Porter stemming, paragraph-aware chunking, normalized scores. Fastest TTFT for ≤1k docs.

For hybrid (BM25 + vector + RRF), see `docs/RAG.md`.

---

## 8. Validators

```ts
import { groundedness, safety, piiRedaction } from '@floe/runtime/validators';

validators: [
  piiRedaction({ phase: 'preLLM', strategy: 'mask' }),
  safety({ phase: 'postLLM' }),
  groundedness(),   // async — logs without blocking, the v1-safe default
],
```

| phase | when | failure |
|---|---|---|
| `preLLM` | before model call | block / retry |
| `postLLM` | before sending response | block / retry / escalate |
| `postLLM-async` | after sending (logging side-channel) | log only |

---

## 9. Hand-off to human

From a flow handler:

```ts
return { kind: 'escalate', to: 'human:billing-team', reason: 'beyond automated policy' };
```

Escalation events come through the response's `events` array as `{ type: 'escalate', to, reason }`. Wire that to your routing system (Slack, Linear, Zendesk).

---

## 10. Run it

```bash
pnpm tsx server.ts
```

Then in another terminal:

```bash
curl -X POST http://localhost:3000/agents/web/session-1 \
  -H 'content-type: application/json' \
  -d '{"message":"I need a refund on invoice inv_881"}'
```

Response:

```json
{
  "result": {
    "text": "You're eligible for a refund of $44.50 on inv_881…",
    "events": [...],
    "state": {...}
  }
}
```

---

## 11. What's next

- **Add a channel.** Slack ships in-box (`@floe/runtime/channels/slack`). Voice via `@floe/runtime/channels/voice`.
- **Swap the model.** Anything `pi-ai` supports. Change `defaults.model`.
- **Persist sessions.** Pass a `SessionStore` implementation to `createFloeApp` (`@floe/session-postgres` is on the roadmap).
- **Observability.** `import { consoleSink, sentrySink, otelSink, braintrustSink } from '@floe/runtime/observability'` — every turn emits a `TurnMetrics` record.
- **Deploy.** Node (Render, Fly, Railway), Cloudflare (Wrangler), Vercel (Edge Functions) — same `floe.config.ts`.

The rest is just code.
