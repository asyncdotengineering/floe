# role-spike

Minimal proof of ADR-0002 (drop Floe Agent, lean on Flue roles).

One conversation, one host agent (the front desk), **two specialist
roles** (`billing`, `engineering`) registered via the new
`conversation.roles` field. The LLM sees the roles in Flue's system
prompt registry and delegates via the auto-injected `task` tool.

**No triage LLM call.** The host model decides whether to delegate.

## Run

```bash
# from this directory
set -a && source ../../.env && set +a   # use .env, NOT .env.local
pnpm spike
```

> **`.env` vs `.env.local` gotcha**: `.env.local` has its values wrapped
> like `KEY="value\n"` — when `source`d, the literal `\n` becomes part
> of the env var and the API key is rejected by the provider. Use
> `.env` (raw values, no quotes) for sourcing.

This sends two messages — a billing question and an engineering
question — and writes `conversation.md` with the full transcript +
event trace.

## What it produces

- **`conversation.md`** — overwritten on every run. Real or attempted
  live transcript. If your API key is invalid the file captures the
  error envelope, which is itself useful (proves the spike code
  wires the request through to the LLM provider correctly).
- **`conversation-simulated.md`** — hand-crafted illustration of what
  a successful run produces. Use this to compare against your real
  output, or to see the shape if you don't want to spend tokens.

## What we found (read `FINDINGS.md`)

Live run proved the role-routing logic works (LLM picks the right role
per question, calls `task({role, prompt})`) AND surfaced an integration
bug: Flue rejects the task with "Session 'default' is already running
prompt." Full analysis + investigation plan in
[`FINDINGS.md`](FINDINGS.md).

## What this spike validates

| Claim | Check |
|---|---|
| `conversation.roles` field exists on `ConversationConfig` | `packages/runtime/src/types.ts` (search "roles?: Record") |
| Roles reach Flue's `agentConfig.roles` | `packages/runtime/src/create-floe-app.ts` (the `allRoles` union) |
| Flue auto-injects `task` tool with role registry | Flue runtime — `repo/flue/packages/runtime/src/agent.ts:300-321` |
| LLM uses `task({role, prompt})` to delegate | Look for `task_start` events in `conversation.md` |
| Per-task `TurnMetrics.tasks.count > 0` | Already captured by `orchestrator/task-tracker.ts` (commit B) |
| No Floe triage call (`runTriage` not invoked) | `triage: 'first-agent'` in `floe.config.ts` skips it |

## What this spike does NOT yet do

- Delete `defineAgent` / `agents[]` / `runTriage` — those still ship
  (the spike adds `roles` **alongside** them, additively, so we can
  prove the new path works before destroying the old one). The full
  deletion is the rest of ADR-0002.
- Migrate the other 6 examples. The spike is its own isolated
  example; the others still use `defineAgent`.
- Per-task tool scoping. Tools (if any) are conversation-level only
  for now; the `task({tools: [...]})` overload is an ADR-0002 edge
  case to revisit if real users hit it.

## File layout

```
role-spike/
├── README.md              # this file
├── floe.config.ts         # the conversation with roles
├── run.ts                 # driver: sends 2 messages, dumps transcript
├── conversation.md        # latest live run (or last attempt error)
├── conversation-simulated.md  # hand-crafted reference output
├── package.json
└── tsconfig.json
```
