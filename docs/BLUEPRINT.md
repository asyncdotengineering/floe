# Floe v1 — Final Blueprint

**Date**: 2026-05-23 (updated)
**Status**: Locked. All future PRs reference this. Major deviations require an ADR amendment.

This blueprint consolidates the position (ADR-0001), primitive cleanup
(originally drafted as ADR-0002 — subsumed; the deletion list now lives
in §3 and the migration plan in §13 Phase 4), coordination vocabulary
(Agno-inspired), adapter shape (vercel/chat-inspired, trimmed to fit our
positioning), and the conversation run API (Agno + Flue CallHandle
hybrid) into one coherent v1 contract.

---

## 1. Position

> **Floe is the TypeScript framework for *agentic conversation*** — apps where the system both maintains a stateful relationship with a human user (across turns, channels, sessions) AND takes real actions in external systems (CRM, ticketing, billing, internal databases) with the isolation, observability, and audit that side effects demand.

**Not for**: pure FAQ chatbots (use Vercel AI SDK), pure coding agents (use Flue directly).
**Built on**: Flue 0.7 → pi-agent-core → pi-ai (LLM provider abstraction). We hide Flue's vocabulary from users; we use its primitives heavily under the hood.

> **Naming note**: positioning uses "agentic conversation" because it's what the framework does from a user's perspective. The code-level primitive is `Assistant` — that's the noun for the configured handler you construct. "Conversation" is what your assistant maintains; "Assistant" is what you build. These are separate words by design, not aliases.

Full positioning, lane comparison, and "what we don't build" filter: [`docs/adr/0001-floe-as-agentic-conversation-framework.md`](adr/0001-floe-as-agentic-conversation-framework.md).

---

## 2. The shape — what user code looks like

The minimum end-to-end Floe app — two files, class primary, subpath imports:

```ts
// assistant.ts
import { Assistant } from '@floe/runtime';
import type { AssistantConfig } from '@floe/runtime';
import { workspaceBm25 } from '@floe/runtime/knowledge';
import { confidence } from '@floe/runtime/validators';
import { linearInbox } from '@floe/runtime/inbox/linear';
import { localSandbox } from '@floe/runtime/sandbox/local';

export const ops = new Assistant({
  systemPrompt: `You are the IT operations bot. Use task() to delegate to
    specialists when relevant. Always file a ticket for any access change.`,
  mode: 'coordinate',                          // see §4
  roles: {
    'access-approver': {
      instructions: 'You evaluate access requests against policy...',
      thinkingLevel: 'high',
    },
  },
  knowledge: [workspaceBm25({ paths: ['knowledge/**'] })],
  validators: [confidence({ disambiguateBelow: 0.6 })],
  handoff: { policy: 'confidence-below-0.4-or-explicit', to: linearInbox({...}) },
  resolveUserId: (input) => input.metadata?.slackUserId as string | undefined,
  sandbox: localSandbox(),
} satisfies AssistantConfig);

// server.ts — user owns the HTTP layer. Each adapter is a separate package.
import { Hono } from 'hono';
import { webAdapter } from '@floe/adapter-web';
import { slackAdapter } from '@floe/adapter-slack';
import { ops } from './assistant.ts';

const app = new Hono();
app.route('/chat',  webAdapter({ assistant: ops }));
if (env.SLACK_SIGNING_SECRET) {
  app.route('/slack', slackAdapter({ assistant: ops, signingSecret: env.SLACK_SIGNING_SECRET }));
}
export default app;
```

Two files. ~60 LOC. Deploys to Node, Vercel, CF Workers, Fly, Render — same code.

`AssistantConfig` is the typed object literal you pass to `new Assistant`. Both `: AssistantConfig` annotation and `satisfies AssistantConfig` work — pick by preference.

---

## 3. Primitives

### `Assistant` (the one Floe-level primitive — class with methods)

The configured handler that turns user messages into actions + replies. Construct with `new Assistant({...})`. Long-lived: configure once at module scope, reuse across requests.

```ts
class Assistant {
  constructor(config: AssistantConfig);

  // The primary call:
  run(userMessage: string, args: RunArgs): TurnHandle;

  // Convenience reads:
  loadState(sessionId: string): Promise<AssistantState>;
  getTranscript(sessionId: string): Promise<TranscriptMessage[]>;
  closeSession(sessionId: string): Promise<void>;
}

interface AssistantConfig {
  systemPrompt: string;
  mode?: AssistantMode;                 // default 'direct'
  roles?: Record<string, Role>;         // forwarded to Flue's auto-injected `task` tool
  knowledge?: KnowledgeSource[];        // retrievable context
  validators?: Validator[];             // preLLM/postLLM/postLLM-async gates
  procedures?: Procedure[];             // passive policy injection (≠ Skill)
  flows?: Flow[];                       // multi-step graph state machines
  handoff?: HandoffConfig;
  memory?: MemoryConfig;
  lifecycle?: LifecycleConfig;
  state?: StateAdapter;                 // unified session+state+transcript+memory; see §7
  sandbox: SandboxFactory | false;      // required; opt-out with false for pure-chat tests
  model: string;                        // 'provider/model-id'
  mcp?: McpServerConfig[];              // process-cached connections
  thinkingLevel?: ThinkingLevel;
  compaction?: CompactionConfig | false;
  observability?: ObservabilityConfig;
  rateLimit?: RateLimiter;
  resolveUserId?: (input: InboundEvent) => string | undefined;
}
```

### `Role` — the only "specialist" primitive
Identical to Flue's `Role` (we re-export). Markdown-defined instructions + optional model/thinkingLevel overrides. NO Floe-level Agent / SubAgent / Specialist class.

```ts
import type { Role } from '@floe/runtime';   // re-export of Flue's Role

const billing: Role = {
  instructions: 'You are a billing expert...',
  thinkingLevel: 'medium',
  // model?: 'openai/gpt-4.1-mini',           // optional override
};
```

Delegation happens via Flue's auto-injected `task({role, prompt})` tool. The host LLM picks the role. No Floe-level triage call.

### `Tool` — user-defined, plus MCP

Two paths: write your own (`defineTool({...})` factory from `@floe/runtime/tool`), or pull from MCP servers (`mcp` config on `AssistantConfig`). MCP is the primary path for "real-world action access."

```ts
import { defineTool } from '@floe/runtime/tool';
import * as v from 'valibot';

const orderLookup = defineTool({
  name: 'order_lookup',
  description: 'Look up an order by ID',
  parameters: v.object({ orderId: v.string() }),
  async execute({ orderId }) { /* hit your API */ },
});
```

### `Knowledge`, `Validators`, `Procedures`, `Flows`, `Handoff`, `Memory`, `Lifecycle`
All current shapes preserved. No structural changes. Each is a factory from its own subpath. See `docs/RAG.md`, `docs/OBSERVABILITY.md`, `docs/PROCEDURE-VS-SKILL.md`.

#### Flow entry — flows-as-tools

Every Flow on `AssistantConfig.flows` is automatically exposed to the LLM as a callable tool named `enter_<flow_slug>`. The LLM picks based on the flow's `description`; multilingual by construction (no regex / keyword matcher). When called, the tool yields a `flow_enter` transition; the orchestrator sets `state.activeFlow`, emits a `flow_enter` event with `data.flow`, and continues the same-turn loop so the flow's `startNode()` executes immediately.

The tool's `args` parameter accepts a free-form record — pass the LLM-extracted structured data (order IDs, product names) which lands on `state.activeFlow.data` and is visible to every node via `ctx.state`. The same primitive pattern as the `delegate(role, prompt)` tool we auto-inject for `mode: 'coordinate'`. See `packages/runtime/src/orchestrator/flow-entry-tools.ts`.

#### Extraction nodes — multi-turn partial-submit

Two node shapes coexist:

- **`defineNode({result, handler})`** — single-shot structured extraction. The LLM is forced to emit the full structured result in one call; `handler(data)` returns the next transition. Use for nodes whose input is always available in the latest user message (e.g. capture-confirmation classifies a yes/no answer).
- **`defineExtractionNode({schema, requiredFields?, onComplete})`** — multi-turn partial extraction. The runtime auto-injects a `submit_<slug>_data` tool with a **nullable+optional** version of `schema`; the LLM submits whatever fields it has heard so far, possibly across multiple turns. The runtime merges into `state.activeFlow.data` and fires `onComplete(data)` only once all `requiredFields` are populated. Pattern lineage: aria-flow's `ExtractionCapability`. Use for nodes that need values the LLM has to *gather conversationally* (e.g. an order ID + return reason when the user only said "I want to return something").

The submit-tool's description is re-rendered every turn with the current missing-field list, so the LLM always knows what's left without prompt-engineering. The system prompt also gets a `# Extraction in progress` block listing `**Already collected:**` + `**Still needed:**`. See `packages/runtime/src/orchestrator/extraction.ts`.

### What gets DELETED at v1.0.0
- `defineAgent` (replaced by Flue Role)
- `defineConversation` (replaced by `new Assistant({...})`)
- `floe.conversation` and the `floe.*` runtime namespace (replaced by `new Assistant` + subpath imports)
- `floe.fetch` auto-router (replaced by per-adapter route mounting via `assistant.run`)
- `Conversation` type (renamed to `Assistant`)
- `ConversationConfig` (renamed to `AssistantConfig`)
- `ConversationState` (renamed to `AssistantState`)
- `ConversationMode` (renamed to `AssistantMode`)
- `ConversationOutputEvent` (renamed to `AssistantOutputEvent`)
- `ConversationConfig.agents[]` (replaced by `roles`)
- `ConversationConfig.triage` (replaced by `mode`)
- `ConversationConfig.channels` (channels become external adapter packages — §6)
- `ConversationState.activeAgentId`, `triagedAt`, `triageVersion` (no agent state to track)
- `agent_handed_off`, `triage_decision` events (replaced by `task_start`/`task` from Flue)
- `runTriage` and `triage.ts` (whole subsystem)
- `TurnMetrics.triage`, `TurnMetrics.agentId` (replaced by `mode`, `tasks`, optional `routedTo`)

---

## 4. Coordination modes (Agno-inspired)

Four modes express the entire coordination spectrum. The mode is an assistant-level default; adapters can override per-call (§5).

```ts
type AssistantMode =
  | 'direct'        // single host, no delegation. 1 LLM call/turn. Default.
  | 'route'         // runtime triages to ONE role. 2 LLM calls/turn (triage + specialist).
  | 'coordinate'    // host LLM delegates via task() tool. 2+N calls (host + tasks + synthesis).
  | 'broadcast';    // fire all roles in parallel, host synthesizes. ~2 wall-clock calls.
```

| Mode | LLM calls/turn | TTFT | End-to-end | Best for |
|---|---|---|---|---|
| `direct` | 1 | ~1.5s | ~2s | FAQ, single domain, voice |
| `route` | 2 | ~2s | ~2.5s | clear domain boundaries, cheap triage model |
| `coordinate` | 2+N | ~1-1.5s* | ~3-5s | complex turns, host stitches specialist outputs |
| `broadcast` | 2+N (parallel) | ~1.5s | ~3-4s wall | compound research, perspective gathering |

(*coordinate's TTFT can beat end-to-end because the host streams "Let me check..." while the task runs.)

**Default = `direct`**. Runtime never burns LLM cost on routing unless the developer opts in. Multi-role users explicitly set `mode: 'coordinate'` (or `'route'` / `'broadcast'`).

Per-channel overrides are NOT an assistant config (we don't have `channels:` anymore). The adapter passes `overlay: { mode: '...' }` per call:

```ts
// Voice adapter strips delegation regardless of assistant default
const result = await assistant.run(transcript, {
  sessionId: callSid,
  overlay: { mode: 'direct', maxResponseTokens: 100 },
});
```

---

## 5. The `run()` API (Agno verb + Flue CallHandle shape)

`Assistant.run` is the only call site. Returns a `TurnHandle` that's awaitable + iterable + cancellable.

```ts
interface RunArgs {
  sessionId: string;
  userId?: string;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
  overlay?: {
    mode?: AssistantMode;
    systemPromptOverlay?: string;
    maxResponseTokens?: number;
    sequentialToolUse?: boolean;
  };
}

interface TurnHandle extends Promise<TurnOutput> {
  /** Async-iterate events as they fire. */
  readonly events: AsyncIterable<AssistantOutputEvent>;
  /** Web-standard ReadableStream for HTTP response bodies. */
  toResponseStream(format?: 'sse' | 'ndjson'): ReadableStream<Uint8Array>;
  /** Cancel this turn (same effect as the caller's signal aborting). */
  cancel(reason?: string): void;
  /** Observe cancellation. */
  readonly signal: AbortSignal;
}

interface TurnOutput {
  runId: string;
  sessionId: string;
  userId?: string;
  content: string;
  messages: TranscriptMessage[];
  metrics: TurnMetrics;
  model: string;
  // Mode-conditional fields:
  mode: AssistantMode;
  routedTo?: string;                                // populated for mode='route'
  tasks: { count: number; totalMs: number; errors: number };
  broadcastFanout?: number;                         // populated for mode='broadcast'
  compaction: { count: number; totalMs: number; messagesDropped: number };
  interrupted: boolean;
}
```

Three faces of the same Handle — each adapter picks the one it needs:

```ts
// (a) Await for the final result — tests, batch jobs, voice (return text)
const result = await assistant.run(msg, { sessionId });

// (b) Iterate events — Slack (incremental thread updates), custom UIs
for await (const event of handle.events) { /* ... */ }

// (c) Pipe to HTTP — web widget, Vercel AI SDK useChat compatibility
return new Response(handle.toResponseStream('sse'));
```

The same `Assistant` instance serves all three. **Single API, three rendering paths.**

---

## 6. Adapters — separate packages, user-mounted, BYO friendly

**Core `@floe/runtime` ships ZERO channel adapters.** Each adapter is an opt-in package.

### Adapter packages (initial set)

| Package | Purpose | LOC est. |
|---|---|---|
| `@floe/adapter-web` | JSON POST + SSE response. Vercel AI SDK `useChat` compatible. | ~80 |
| `@floe/adapter-slack` | Signed webhook verification, threaded reply, Block Kit-aware text. | ~200 |
| `@floe/adapter-elevenlabs` | ElevenLabs Conversational AI webhook → run with voice overlay → reply text. | ~120 |
| `@floe/adapter-twilio` | Twilio voice webhook + TwiML out. | ~150 |
| `@floe/adapter-vapi` | Vapi assistant webhook. | ~120 |
| `@floe/adapter-cf-workers` | CF Workers fetch handler convenience + DO bridging. | ~60 |

Each adapter:
1. Exposes a single factory: `slackAdapter({ assistant, signingSecret })` → `Hono` app fragment
2. Parses inbound platform payload → calls `assistant.run(...)` with appropriate overlay
3. Renders outbound (text-out, SSE, ReadableStream, platform-specific message format)
4. Has its own optional peer deps (`@slack/bolt`, `twilio`, etc.) so users only install what they use

### BYO escape hatch
Users with proprietary platforms (in-product widget, internal MQTT bridge, custom telephony) write their own adapter — it's a function that:
1. Parses their inbound shape
2. Calls `assistant.run(message, {sessionId, userId, overlay})`
3. Renders the response however they want

**No framework lock-in** for the channel layer. Adapter packages are conveniences, not requirements.

### What we DO NOT ship (vs. vercel/chat)
- ❌ JSX card rendering (`<Card><Button id="x">`) — out of scope
- ❌ Cross-platform mdast format converters — text is the contract
- ❌ Unified event model with 8+ event types (`onAction`, `onModalSubmit`, etc.) — we have ONE event: a user turn arrived
- ❌ Modal / Button / Select / RadioSelect / Table / etc. UI primitives
- ❌ `thread.openDM`, `thread.postEphemeral`, `thread.pin` and similar platform UX wrappers

Our adapters do parsing + delivery. The `Assistant` owns conversation semantics. Rich UI is the user's frontend's concern.

---

## 7. State stores — separate packages, plug-and-play

Same hygiene as adapters. Core ships in-memory; durable stores are opt-in packages.

| Package | Backing | Use case |
|---|---|---|
| `@floe/state-memory` | In-process Map | Tests, single-machine dev, ephemeral demos |
| `@floe/state-libsql` | Turso (libsql) | Default production — global edge, low write latency |
| `@floe/state-redis` | Redis | Existing Redis infra |
| `@floe/state-pg` | Postgres | Existing Postgres infra |
| `@floe/state-cf-do` | CF Durable Objects SQLite | Cloudflare Workers single-writer model |

Each state package exports a `StateAdapter` that bundles `SessionStore`, `AssistantStateStore`, `TranscriptStore`, and `MemoryService` — a single object passed as `state` on `AssistantConfig`.

```ts
import { Assistant } from '@floe/runtime';
import { libsqlState } from '@floe/state-libsql';

const state = libsqlState({ url: env.TURSO_URL, authToken: env.TURSO_TOKEN });

export const ops = new Assistant({
  // ...
  state,                                       // wires sessions + state + transcript + memory
});
```

Same pluggable shape as `@chat-adapter/state-redis` vs `@chat-adapter/state-pg` in vercel/chat. **Existing `InMemoryMemoryService` and `LibsqlMemoryService` migrate into these packages.**

---

## 8. DX surface — class primary + subpath imports (Hono-style)

One class, many subpath imports. NO `floe.*` runtime namespace.

```ts
// One primary import for the class
import { Assistant } from '@floe/runtime';

// Type imports from the main entry (no runtime cost)
import type {
  AssistantConfig, AssistantMode, AssistantState, AssistantOutputEvent,
  RunArgs, TurnHandle, TurnOutput,
  Role, KnowledgeSource, Validator, HandoffConfig,
} from '@floe/runtime';

// Subpath imports for helpers — tree-shakeable, jump-to-source-clean
import { defineTool } from '@floe/runtime/tool';
import { workspaceBm25, hybridKnowledge } from '@floe/runtime/knowledge';
import { confidence, safety, piiRedaction } from '@floe/runtime/validators';
import { linearInbox } from '@floe/runtime/inbox/linear';
import { localSandbox, cfBashSandbox } from '@floe/runtime/sandbox';
import { openaiEmbedder } from '@floe/runtime/embedders/openai';
import { InMemoryVectorStore } from '@floe/runtime/vectorstores';

// External: state + adapters are SEPARATE packages
import { libsqlState } from '@floe/state-libsql';
import { webAdapter } from '@floe/adapter-web';
import { slackAdapter } from '@floe/adapter-slack';
```

### Subpath conventions (already shipped, formalized here)

```
@floe/runtime              — Assistant class + types
@floe/runtime/tool         — defineTool
@floe/runtime/knowledge    — workspaceBm25, hybridKnowledge
@floe/runtime/validators   — confidence, safety, piiRedaction, groundedness, emergencyGuard
@floe/runtime/inbox/linear — linearInbox        (per-vendor subpath = per-vendor peer dep)
@floe/runtime/inbox/zendesk
@floe/runtime/inbox/genesys
@floe/runtime/sandbox      — localSandbox, cfBashSandbox, noneSandbox
@floe/runtime/embedders/openai
@floe/runtime/embedders/workers-ai
@floe/runtime/embedders/ai-sdk
@floe/runtime/vectorstores — InMemoryVectorStore (+ subpaths per backend)
@floe/runtime/rerankers/llm-judge
@floe/runtime/chunkers
@floe/runtime/observability — otelSink, braintrustSink, consoleSink
@floe/runtime/memory       — MemoryService interface + helpers
```

State stores and channel adapters live in **separate packages** (not subpaths of `@floe/runtime`), since they have their own peer dependencies:

```
@floe/state-memory
@floe/state-libsql
@floe/state-redis
@floe/state-pg
@floe/state-cf-do
@floe/adapter-web
@floe/adapter-slack
@floe/adapter-elevenlabs
@floe/adapter-twilio
@floe/adapter-vapi
@floe/adapter-cf-workers
```

### Why subpath imports beat `floe.*` namespace

- ✅ **Tree-shakeable** — bundlers strip unused helpers. The `floe.*` runtime object would import everything.
- ✅ **Jump-to-source** — IDE cmd-click jumps straight to the helper's source; no re-export layer.
- ✅ **Matches existing exports** — `package.json#exports` already declares these subpaths. We're using the structure we shipped.
- ✅ **Industry convention** — Hono (`import { cors } from 'hono/cors'`), AI SDK (`import { openai } from '@ai-sdk/openai'`), Drizzle (`import { pgTable } from 'drizzle-orm/pg-core'`). Users have muscle memory.
- ✅ **No collision** between "class you construct" and "namespace of helpers" (the React `React.useState` baggage trap).

Trade-off: a typical `assistant.ts` has 5-8 import lines instead of 2. Modern auto-import handles this (type the symbol + the IDE adds the import line). The clarity wins.

---

## 9. Deployment per platform

Mode is a runtime decision, not deploy-time. Same artifact handles all modes.

### Node (Vercel, Render, Fly, Railway, ECS)

```ts
// server.ts
import { serve } from '@hono/node-server';
import app from './server.ts';   // the Hono app from §2
serve({ fetch: app.fetch, port: 3000 });
```

All four modes work. Caveat: `broadcast` should cap concurrency per turn (`maxConcurrent` on the broadcast config, default 4) so a 12-role config doesn't fan out to 12 concurrent provider calls.

### Cloudflare Workers

```ts
// worker.ts
import app from './server.ts';
export default { fetch: app.fetch };
export { FlueRegistry } from '@floe/runtime/cloudflare';
export { AssistantDO } from '@floe/adapter-cf-workers';
```

```jsonc
// wrangler.jsonc — minimal
{
  "name": "ops-bot",
  "main": "worker.ts",
  "compatibility_date": "2026-05-23",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [
      { "name": "FLUE_REGISTRY", "class_name": "FlueRegistry" }
    ]
  }
}
```

- `direct` / `route` / `coordinate` work as-is
- `broadcast` watch subrequest limit (50 free / 1000 paid)
- Use `@floe/state-cf-do` for DO SQLite-backed state OR `@floe/state-libsql` for Turso

### Voice gateways (Twilio / LiveKit / Vapi / ElevenLabs)

Speech engine handles STT/TTS + barge-in. Floe is brain-only.

```ts
// Voice adapter forces mode='direct' regardless of assistant default
app.route('/voice', elevenLabsAdapter({
  assistant: ops,
  secret: env.ELEVENLABS_WEBHOOK_SECRET,
  // adapter internally sets overlay.mode = 'direct' on every run() call
}));
```

TTFT budget for voice: ~500-800ms. `direct` clears it; `route` borderline with cheap triage model; `coordinate`/`broadcast` don't.

### Vercel deploy

Existing `api/build-entry.ts` + `vercel-build.ts` pattern survives. No changes — same code, BYO adapters mounted in the user's API route.

---

## 10. Observability

`TurnMetrics` gains `mode` + mode-conditional fields. Existing `tasks` / `compaction` / `interrupted` fields kept.

```ts
interface TurnMetrics {
  runId: string;
  mode: AssistantMode;
  assistantName: string;                         // set when AssistantConfig.name is provided
  channelName?: string;                          // set by adapter via metadata
  isVoice: boolean;
  userId: string | null;
  startedAtMs: number;
  endedAtMs: number;
  stages: TurnStageLatencies;
  tokens: TurnTokenUsage;
  models: string[];
  producedReply: boolean;
  validatorVerdict: 'ok' | 'retry' | 'escalate' | 'rewrite' | 'disambiguate' | 'block';
  knowledge: { source: string; chunks: number }[];
  memoryPreloadCount: number;

  // Mode-conditional:
  routedTo?: string;                             // only when mode='route'
  tasks: { count: number; totalMs: number; errors: number };
  broadcastFanout?: number;                      // only when mode='broadcast'

  // From commits B/C/E:
  interrupted: boolean;
  compaction: { count: number; totalMs: number; messagesDropped: number };

  tags?: Record<string, string>;
}
```

Sinks already pluggable from `@floe/runtime/observability`: `otelSink`, `braintrustSink`, `consoleSink`. Add `mode` as a span attribute.

Operators can answer:
- "Which mode dominates our cost?" → group by `mode`
- "Is `coordinate` actually delegating or is the host answering directly?" → `tasks.count` distribution within `mode='coordinate'`
- "Is `route` hitting the right role?" → distribution of `routedTo`
- "Per-channel latency degradation?" → split by `metrics.channelName`

---

## 11. What we keep doing right (the things this blueprint preserves)

These were already correct; the blueprint formalizes them.

1. **Sandbox required (Pattern C)** — action-taking bots need real tool isolation. The `false` opt-out exists for tests and pure-chat shims.
2. **MCP via `mcp` field on `AssistantConfig`** — process-cached connections, failure-isolated, lazy.
3. **Validators with `preLLM` / `postLLM` / `postLLM-async` phases** — emergency guards run pre-LLM with zero LLM cost.
4. **Procedures separate from Skills** (per ADR-0001's companion doc).
5. **Lifecycle states** (`active | idle | abandoned | escalated | closed`) — runtime-driven, time-based.
6. **Handoff via `HandoffPolicy + InboxPort`** — typed escalation, per-outcome routing.
7. **Memory keyed by `resolveUserId`** — cross-channel bridging without explicit session merging.
8. **Mid-turn interrupt + supersession** (commit C) — `signal` threads through `run` → `session.prompt` → tool execute.
9. **Per-turn task delegation telemetry** (commit B) — `TurnMetrics.tasks`.
10. **Compaction telemetry** (commit E) — `TurnMetrics.compaction`.

---

## 12. What we explicitly do NOT build

Tier 1 — already in ADR-0001:
- Visual flow builder
- Managed hosting product
- Vertical CX UI components
- CrewAI-style swarm orchestration beyond what Flue's `task` gives

Tier 2 — added by this blueprint:
- JSX card rendering / Block Kit / Adaptive Cards primitives
- Modal / Button / Select / RadioSelect / Table UI elements
- Cross-platform mdast format converters
- Unified event model beyond "user turn arrived" (no `onAction`, `onModalSubmit`, `onMemberJoinedChannel`, etc.)
- `thread.openDM` / `thread.postEphemeral` / `thread.pin` and similar platform UX wrappers
- A second multi-agent orchestration layer beyond Flue's `task`
- A `floe.*` runtime namespace (subpath imports do the job)

If a user asks for any of these, the answer is: "use vercel/chat for rich-UI bot needs; Floe gives you the `Assistant` primitive."

---

## 13. Migration plan — from current state to blueprint

### Phase 1 — Foundation (adds, no breaking changes)
Total: ~3 PRs, ~4-6 hours

| # | Change | Status |
|---|---|---|
| P1.1 | Add `Conversation.systemPrompt: string` (optional), `roles: Record<string, Role>` to `ConversationConfig`. Wire `roles` through to Flue `agentConfig.roles` (already shipped in spike). | ✅ shipped |
| P1.2 | Add `ConversationConfig.mode: ConversationMode`. Resolve to existing triage paths internally. Default `'direct'` for new field but PRESERVE current triage default if `triage` is set explicitly. | TODO |
| P1.3 | Add `Conversation.run(message, args): TurnHandle`. Internally calls into the existing orchestrator's `runConversationTurn`. Keep `floe.fetch` as compat wrapper. | TODO |
| P1.4 | Fix the session-lock bug surfaced in `examples/role-spike/FINDINGS.md` so `coordinate` mode delegations actually execute. | TODO (BLOCKER for coordinate) |

### Phase 1b — Class rename + DX shape
Total: ~2 PRs, ~3-4 hours

| # | Change | Status |
|---|---|---|
| P1b.1 | Introduce `Assistant` class as an alias over the existing `Conversation` plumbing. Export from main entry. Both names compile during transition. | TODO |
| P1b.2 | Rename internal types: `ConversationConfig` → `AssistantConfig`, `ConversationState` → `AssistantState`, `ConversationMode` → `AssistantMode`, `ConversationOutputEvent` → `AssistantOutputEvent`. Compat type aliases kept until Phase 4. | TODO |

### Phase 2 — Adapter split
Total: ~5 PRs, ~6-8 hours

| # | Change | Status |
|---|---|---|
| P2.1 | Create `@floe/adapter-web` package. Move `channels/web-chat.ts` into it. Adapter factory takes `{ assistant }`. | TODO |
| P2.2 | Create `@floe/adapter-slack` package. Move `channels/slack.ts`. Add real signing verification (we currently have a stub). | TODO |
| P2.3 | Create `@floe/adapter-elevenlabs` package. Move `channels/voice.ts`. Voice-specific overlay defaults (`mode: 'direct'`). | TODO |
| P2.4 | Deprecate `AssistantConfig.channels` field. Emit warning at construction if set. | TODO |
| P2.5 | Update use-case docs 01/02/03 to show the adapter pattern. | TODO |

### Phase 3 — State store split
Total: ~3 PRs, ~3-4 hours

| # | Change | Status |
|---|---|---|
| P3.1 | Create `@floe/state-memory`, `@floe/state-libsql` packages. Move `InMemoryMemoryService` + `LibsqlMemoryService` + state stores. | TODO |
| P3.2 | Add `AssistantConfig.state` field that unifies session+state+transcript+memory store passing. | TODO |
| P3.3 | Update examples to pass `state` instead of separate stores. | TODO |

### Phase 4 — Destruction
Total: ~2 PRs, ~3-4 hours

| # | Change | Status |
|---|---|---|
| P4.1 | Delete `defineAgent`, `defineConversation`, `runTriage`, `triage.ts`, `AssistantConfig.{agents, triage, defaultAgentId, channels}`, `AssistantState.{activeAgentId, triagedAt, triageVersion}`, `agent_handed_off` + `triage_decision` events, `TurnMetrics.triage`, `TurnMetrics.agentId`. Drop the `Conversation*` compat type aliases. | TODO (blocked on P1, P1b) |
| P4.2 | Delete `floe.fetch`. Remove from `create-floe-app.ts`. Examples already migrated in Phase 2. | TODO (blocked on P2) |

### Phase 5 — Cleanup + canary
Total: ~2 PRs, ~3-4 hours

| # | Change | Status |
|---|---|---|
| P5.1 | Migrate all 6 examples to the new shape. `support-bot` is the make-or-break — must demonstrate `mode: 'coordinate'` with `task` delegation across `service` + `sales` roles. | TODO |
| P5.2 | Vercel re-deploy `support-bot` + `mcp-bot`. 4/4 RAG paths green. Update ADR-0001 reaffirmation note. | TODO |

### Phase 6 — Documentation lockdown
Total: ~1 PR, ~2 hours

| # | Change | Status |
|---|---|---|
| P6.1 | Rewrite README around blueprint. Replace "Conversation" with "Assistant" in code samples; positioning copy unchanged. | TODO |
| P6.2 | Update use-case docs (01/02/03) markers from 🔜 to ✅. Add use-case 04: voice-only bot demonstrating `direct` mode. | TODO |

**Total estimate**: ~18 PRs, ~25-32 hours. Realistically two focused weeks of work for one engineer; could fan out to multiple engineers since Phases 2/3 are mostly independent.

---

## 14. Sequencing & milestones

```
┌────────────────────────────────────────────────────────────────┐
│ MILESTONE M1 — "Modes + run() ship"  (Phase 1 done)              │
│ - role-spike works end-to-end with coordinate mode               │
│ - direct mode is the default                                     │
│ - Conversation.run() returns TurnHandle                          │
│ - Backward compat: existing examples still work via floe.fetch   │
│ Gate: support-bot live test passes via mode='coordinate'         │
└────────────────────────────────────────────────────────────────┘
                            ↓
┌────────────────────────────────────────────────────────────────┐
│ MILESTONE M1.5 — "Assistant rename"  (Phase 1b done)             │
│ - Assistant class exported; Conversation kept as type alias      │
│ - All internal types renamed (Config/State/Mode/Event)           │
│ - Examples can use either Assistant or Conversation              │
│ Gate: tsc clean, 224+ tests green, role-spike uses `new Assistant` │
└────────────────────────────────────────────────────────────────┘
                            ↓
┌────────────────────────────────────────────────────────────────┐
│ MILESTONE M2 — "Adapters split"  (Phase 2 done)                  │
│ - @floe/adapter-web, -slack, -elevenlabs published               │
│ - AssistantConfig.channels deprecated (warn, not delete)         │
│ - All 6 examples updated to BYO adapter pattern                  │
│ Gate: Vercel deploy of support-bot via @floe/adapter-web green   │
└────────────────────────────────────────────────────────────────┘
                            ↓
┌────────────────────────────────────────────────────────────────┐
│ MILESTONE M3 — "State store split"  (Phase 3 done)               │
│ - @floe/state-memory, -libsql published                          │
│ - Unified AssistantConfig.state field                            │
│ Gate: Turso-backed support-bot survives a full deploy            │
└────────────────────────────────────────────────────────────────┘
                            ↓
┌────────────────────────────────────────────────────────────────┐
│ MILESTONE M4 — "v1.0.0"  (Phase 4, 5, 6 done)                    │
│ - defineAgent + defineConversation + triage + activeAgentId DEL  │
│ - floe.fetch DELETED; Conversation* type aliases DELETED         │
│ - README + use-case docs match blueprint                         │
│ - All 6 examples migrated                                        │
│ Gate: git grep returns ZERO hits for deleted symbols             │
└────────────────────────────────────────────────────────────────┘
```

---

## 15. Acceptance gates per milestone

### M1 acceptance
- [ ] `examples/role-spike/conversation.md` shows successful `task` delegation (no session-lock error)
- [ ] `Conversation.run(message, {sessionId})` returns a `TurnHandle` that is `await`able + iterable + `.toResponseStream()`able
- [ ] Default `mode` for new conversations is `'direct'`; explicit `mode: 'route'`/`'coordinate'`/`'broadcast'` all functional
- [ ] All 224 existing tests still pass
- [ ] New tests: ≥5 covering each mode's happy path; ≥3 covering Handle's three faces (await / iterate / stream)

### M1.5 acceptance
- [ ] `import { Assistant } from '@floe/runtime'` works
- [ ] `new Assistant({...})` constructs successfully and has `.run()`, `.loadState()`, `.getTranscript()`, `.closeSession()`
- [ ] `Conversation` still importable as a type alias for compat
- [ ] role-spike example switches to `new Assistant({...})` and live run still works
- [ ] tsc clean, 224+ tests green

### M2 acceptance
- [ ] `@floe/adapter-web` published, used by ≥3 examples
- [ ] `@floe/adapter-slack` published, signed-webhook verification works against real Slack
- [ ] `@floe/adapter-elevenlabs` published, used by a voice-channel example
- [ ] `AssistantConfig.channels` emits deprecation warning, still functional
- [ ] Vercel `support-bot` deploy: 4/4 RAG paths green via the new adapter

### M3 acceptance
- [ ] `@floe/state-libsql` powers `support-bot` end-to-end (sessions + state + transcript + memory)
- [ ] State packages are independently versionable

### M4 acceptance (v1.0.0)
- [ ] `git grep -i 'defineAgent\|defineConversation\|runTriage\|activeAgentId\|agent_handed_off\|triage_decision\|floe\.fetch\|floe\.conversation\|floe\.knowledge\|floe\.validator\|floe\.inbox\|floe\.sandbox' -- 'packages/**' 'examples/**'` returns 0 hits
- [ ] `git grep 'Conversation\b' -- 'packages/runtime/src/**'` returns only type-alias declarations OR zero hits if aliases dropped
- [ ] README's imports section reflects the subpath-imports pattern (8-10 typical imports for a full example)
- [ ] All use-case docs markers updated to ✅
- [ ] Bench comparison: `direct` mode median TTFT < current single-agent TTFT (proves we didn't regress)
- [ ] ADR-0001 reaffirmation note updated with v1.0.0 date

---

## 16. What changes for the existing follow-ups

| Existing task | New status under blueprint |
|---|---|
| #66 CF #1: worker.ts + wrangler.jsonc | Folded into M2 (CF deploy via `@floe/adapter-cf-workers`) |
| #67 CF #2: bundle markdown into InMemoryFs | Folded into M2 — still needed for CF deploys |
| #68 CF #3: secrets + deploy + verify | Folded into M2 acceptance gate |

The 5 commits already shipped (Pattern C, A=MCP, B=task telemetry, C=interrupt, E=compaction, G=Procedure-vs-Skill) all PRESERVED under this blueprint. No rework. They're foundation.

---

## 17. Open questions (deferred, not blocking)

1. **`broadcast` mode's `Promise.all` semantics**: any-fail vs all-must-succeed? Default = all-must-succeed; partial-failure mode opt-in. Revisit when a real user pulls.
2. **`mode: 'coordinate'` with parallel `task` calls**: today's `task` tool can be invoked in parallel by the host LLM. Do we cap concurrency in coordinate mode the way broadcast does? Probably yes, same `maxConcurrent` config.
3. **Per-role tool scoping**: `task({role, tools})` exists in Flue. Do we expose this as a Floe-level config (`role.tools`) or leave it to power users to construct via prompt? Defer — wait for ≥3 real users to ask.
4. **Adapter package versioning**: lockstep with core, or independent? Lean independent — adapters move faster than core. Revisit at M2.
5. **Pricing/usage budgets per assistant**: cap `tokensPerTurn` or `costPerTurn` to prevent runaway broadcasts? Real concern at scale. Defer to post-v1.
6. **`Assistant` config file naming convention**: `assistant.ts` (singular per file), `assistants/<name>.ts` (multi-assistant projects), or `floe.config.ts` (Vite-style)? Pick at M4. Examples currently use `floe.config.ts` for backward compat; lean toward `assistant.ts` going forward.

---

## 18. References

- [ADR-0001: Floe as agentic-conversation framework](adr/0001-floe-as-agentic-conversation-framework.md)
- [Procedure vs Skill (companion ADR)](PROCEDURE-VS-SKILL.md)
- [Use-case 01: Internal IT/HR ops bot](use-cases/01-internal-ops-bot.md)
- [Use-case 02: B2C subscription bot](use-cases/02-b2c-subscription-bot.md)
- [Use-case 03: B2C clinic bot](use-cases/03-b2c-clinic-bot.md)
- [Role spike findings](../examples/role-spike/FINDINGS.md)

---

**This blueprint is the v1 contract.** Future PRs that touch the assistant/role/mode/adapter/state surface must either fit this blueprint or amend it via a new ADR. Reviewers can use §11 (keep), §12 (don't build), and §15 (acceptance gates) as the per-PR checklist.
