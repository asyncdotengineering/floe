# Floe

> The TypeScript framework for **agentic conversation** — bots that maintain a stateful relationship with a human user AND take real actions in external systems with the isolation, observability, and audit that side effects demand.

**Not for**: pure FAQ chatbots (use Vercel AI SDK), pure coding agents (use [Flue](https://github.com/withastro/flue) directly).
**Built on**: Flue → pi-agent-core → pi-ai. We hide Flue's vocabulary from users; we use its primitives heavily under the hood.

Floe positions in the intersection — **stateful dialogue + action-taking**. Examples: internal IT/HR ops bots, sales SDR bots, external CX bots that issue refunds, voice agents that take appointments.

Full positioning + the "what we don't build" filter: [`docs/adr/0001-floe-as-agentic-conversation-framework.md`](docs/adr/0001-floe-as-agentic-conversation-framework.md).
Locked v1 contract: [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md).

---

## Install

```bash
pnpm add @floe/runtime @floe/adapter-web
```

> Flue (`@flue/runtime`) is the runtime engine underneath. It ships as a transitive dep of `@floe/runtime` — you never install or import it directly.

## Minimum end-to-end app — two files, ~50 LOC

```ts
// assistant.ts
import { Assistant } from '@floe/runtime';
import { workspaceBm25 } from '@floe/runtime/knowledge/workspace-bm25';
import { confidence } from '@floe/runtime/validators';
import { localSandbox } from '@floe/runtime/sandbox/local';

export const ops = new Assistant({
  name: 'ops',
  mode: 'coordinate',                          // see § Modes
  systemPrompt: `You are the IT operations bot. Use delegate() to ask a
    specialist role when relevant. File a ticket for any access change.`,
  roles: {
    'access-approver': {
      name: 'access-approver',
      description: 'Approves access requests against policy.',
      instructions: 'You evaluate access requests...',
      thinkingLevel: 'high',
    },
  },
  knowledge: [workspaceBm25({ name: 'policies', paths: ['knowledge/**/*.md'] })],
  validators: [confidence({ disambiguateBelow: 0.6 })],
  sandbox: localSandbox(),
  model: 'anthropic/claude-sonnet-4-6',
});
```

```ts
// server.ts
import { serve } from '@hono/node-server';
import { webAdapter } from '@floe/adapter-web';
import { ops } from './assistant.ts';

const app = webAdapter({ assistant: ops });
serve({ fetch: app.fetch, port: 3000 });
```

That's it. Send a POST to `http://localhost:3000/agents/web/<sessionId>` with `{message: "..."}` and you have an action-taking, role-delegating, stateful conversation.

---

## Primitives

### `Assistant` — the one Floe-level primitive

The configured handler that turns user messages into actions + replies. Construct with `new Assistant({...})`. Long-lived: configure once at module scope, reuse across requests.

```ts
interface AssistantConfig {
  name: string;
  systemPrompt: string;
  mode?: AssistantMode;                  // default 'direct'
  roles?: Record<string, Role>;          // specialist role registry
  tools?: FloeTool[];                    // shared with all roles via delegate
  flows?: Flow[];                        // multi-step state machines
  procedures?: Procedure[];              // passive policy injection
  knowledge?: KnowledgeSource[];
  validators?: Validator[];
  memory?: MemoryConfig | false;
  persona?: PersonaConfig;
  model?: string;                        // 'provider/model-id'
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh';
  sandbox: SandboxFactory | false;       // required; opt-out with false
  configDir?: string;
  resolveUserId?: (input) => string | undefined;
}
```

### `Role` — the only specialist primitive

A Role is Flue's `Role` (we re-export). Markdown-defined instructions + optional model/thinkingLevel overrides. **No defineAgent, no Floe-level Agent class.**

```ts
import type { Role } from '@floe/runtime';

const billing: Role = {
  name: 'billing',
  description: 'Billing specialist — pricing, refunds, plan changes',
  instructions: 'You are a billing expert. ...',
  thinkingLevel: 'medium',
  // model?: 'openai/gpt-4.1-mini',     // optional override
};
```

Delegation happens via Floe's `delegate({role, prompt})` tool, automatically injected when `mode='coordinate'` and `roles` is non-empty.

### `Procedures`, `Flows`, `Knowledge`, `Validators`, `Memory`

All preserved unchanged from v0. See:
- `docs/SUPPORT-BOT-BLUEPRINT.md` — **start here if you're building** — layered Layer 0 → Layer 9 walkthrough from minimum-viable to production, cross-referenced to every primitive
- `docs/FLOWS.md` — the 4 node kinds (Extraction / Capture / Compute / Reply) with worked examples
- `docs/LATENCY.md` — performance budgets, the streaming architecture, the dials you can turn
- `docs/RAG.md` — knowledge + retrieval
- `docs/OBSERVABILITY.md` — turn metrics + sinks
- `docs/PROCEDURE-VS-SKILL.md` — Procedure (passive) vs Flue Skill (active)

---

## Modes

Floe expresses the coordination spectrum via four explicit modes (Agno-inspired). The mode is an Assistant-level default; adapters can override per call.

| Mode | LLM calls/turn | TTFT | Best for |
|---|---|---|---|
| `direct` (**default**) | 1 | ~1.5s | FAQ, single domain, voice |
| `route` | 2 (triage + specialist) | ~2s | Clear domain boundaries, cheap triage model |
| `coordinate` | 2+N (host + tasks + synthesis) | ~1-1.5s* | Complex turns, host stitches specialist outputs |
| `broadcast` | 2+N (parallel) | ~1.5s | Compound research, perspective gathering |

(*coordinate's TTFT can beat end-to-end because the host streams "Let me check..." while the task runs.)

**Default = `direct`**. The runtime never burns LLM cost on routing unless you opt in. Multi-role Assistants explicitly set `mode: 'coordinate'` (or `'route'` / `'broadcast'`).

### Per-call override

Adapters can override the mode per `run()` call — e.g., a voice adapter strips delegation regardless of the Assistant default:

```ts
await assistant.run(transcript, {
  sessionId: callSid,
  overlay: { mode: 'direct', maxResponseTokens: 100 },
});
```

---

## The `Assistant.run()` API

Returns a `TurnHandle` that's awaitable + iterable + cancellable + pipeable to an HTTP response.

```ts
const handle = ops.run('Hello', { sessionId: 'user-1' });

// (a) Await for the final result
const result = await handle;          // { content, runId, sessionId, mode, ... }

// (b) Iterate events as they happen
for await (const event of handle.events) { /* ... */ }

// (c) Pipe to HTTP — web widget, AI SDK useChat compatibility
return new Response(handle.toResponseStream('sse'));

// (d) Cancel mid-turn (or wire to a client AbortSignal)
handle.cancel('user navigated away');
```

Mount the Assistant via an adapter once at module scope — e.g. `webAdapter({ assistant: ops })` from `@floe/adapter-web`. Programmatic `assistant.run(...)` works after that without further wiring.

---

## Channels — BYO + one in-core

Core ships exactly one channel adapter: **`@floe/adapter-web`** — `webAdapter({ assistant })` returns a Hono-mountable `{fetch, route}`. JSON POST + SSE response. Vercel AI SDK `useChat` compatible.

For Slack / voice / Twilio / WhatsApp / custom platforms: **write your own adapter**. An adapter is a function that:
1. Parses the inbound platform webhook
2. Calls `assistant.run(message, {sessionId, userId, overlay})`
3. Renders the response however the platform wants

Floe doesn't ship `defineChannel` for non-web. The slack/voice adapters that previously lived in core have been deleted — they're better handled as separate packages (`@floe/adapter-slack`, `@floe/adapter-elevenlabs`, etc.) on the user's roadmap or built in 30 LOC inline.

---

## What we do not build

Tier 1 (positioning):
- Visual flow builder
- Managed hosting product
- Vertical CX UI components
- CrewAI-style swarm orchestration beyond what Flue's `task` gives

Tier 2 (DX surface):
- JSX card rendering (Block Kit, Adaptive Cards) — out of scope; use vercel/chat if you need that
- Modal / Button / Select / RadioSelect UI primitives
- Cross-platform mdast format converters
- Unified event model beyond "user turn arrived"
- `floe.*` runtime namespace — subpath imports do the job

---

## Subpath import map

The `floe.*` runtime namespace was rejected — too many indirection, broken tree-shaking. Use subpath imports (Hono-style):

```ts
import { Assistant, defineTool } from '@floe/runtime';
import { webAdapter } from '@floe/adapter-web';
import { workspaceBm25, hybridKnowledge } from '@floe/runtime/knowledge';
import { confidence, safety, piiRedaction } from '@floe/runtime/validators';
import { localSandbox, cfBashSandbox, noneSandbox } from '@floe/runtime/sandbox';
import { openaiEmbedder } from '@floe/runtime/embedders/openai';
import { InMemoryVectorStore } from '@floe/runtime/vectorstores';
```

Full subpath list in `packages/runtime/package.json#exports`.

---

## Docs

- [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md) — locked v1 contract (this is the source of truth)
- [`docs/adr/0001-floe-as-agentic-conversation-framework.md`](docs/adr/0001-floe-as-agentic-conversation-framework.md) — positioning
- [`docs/PROCEDURE-VS-SKILL.md`](docs/PROCEDURE-VS-SKILL.md) — Procedure (passive) vs Flue Skill (active) — kept separate by design
- [`docs/use-cases/`](docs/use-cases/) — concrete walkthroughs (IT ops, B2C subscription, B2C clinic)
- [`docs/RAG.md`](docs/RAG.md), [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md), [`docs/EVAL.md`](docs/EVAL.md), [`docs/OPENAI-COMPAT.md`](docs/OPENAI-COMPAT.md)

## Examples

- `examples/role-spike/` — minimal mode='coordinate' canary (live-verified)
- `examples/streaming-bot/` — single-Assistant streaming
- `examples/mcp-bot/` — MCP tool wiring + stub MCP server
- `examples/memory-bot/` — cross-session memory keyed by userId
- `examples/hybrid-rag-bot/` — BM25 + embeddings + reranker
- `examples/flow-bot/` — multi-step flow
- `examples/support-bot/` — multi-role (mode='coordinate' with service + sales)
- `examples/ecommerce-bot/` — full production-shaped bot with Turso state

## License

MIT.
