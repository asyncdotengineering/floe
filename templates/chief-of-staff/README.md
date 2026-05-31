# Chief-of-staff — personal AI for ONE leader, coordinating across the org

A clone-and-go Floe template for the **chief-of-staff** role: the
agent that works for ONE leader (CEO/founder/CTO) and coordinates
across the entire org on their behalf. Drafts strategic comms in the
leader's voice, prepares every meeting with full context, tracks
commitments so nothing slips.

The **5th lighthouse**, distinct from the 3 customer-facing templates
AND from `knowledge-worker`:

| | Customer-facing (ops/hearth/cedar) | knowledge-worker | **chief-of-staff** |
|---|---|---|---|
| Audience | Company's customers/employees | YOU (one IC) | ONE leader |
| Output audience | The bot's user (a customer) | The bot's owner (you) | **The whole org** (board, customers, all-hands) |
| Polish bar | Conversational | Personal/internal | **Strategic — board-grade** |
| Tracked state | Per-customer scope | Personal scope | **Org-wide cross-team state** |
| Bot autonomy | Acts on shared systems | Drafts, you send | **Drafts everything external; org-wide commits NEVER autonomous** |

## What you get out of the box

- ✅ One **Floe Assistant** in `coordinate` mode with 3 specialist roles:
  - **`comms-drafter`** (`thinkingLevel: 'high'`) — board updates,
    all-hands, customer emails. Reads `communication-norms.md` first.
  - **`exec-briefer`** (`thinkingLevel: 'high'`) — pre-meeting briefs:
    pulls everything relevant for an upcoming meeting (event +
    attendees + recent emails + open tickets + prior commitments) into
    a 1-page brief.
  - **`commitment-tracker`** — surfaces what the leader has promised
    whom; supports logging new commitments + flipping status as work
    completes.
  - **`deep-researcher`** (`thinkingLevel: 'high'`) — **background-only
    worker**. Multi-step research spanning 4+ MCPs. Always enqueued via
    the jobs MCP — never inline.
- ✅ Six **MCP servers**:
  - 4 bundled (Notion docs, Linear tickets, Calendar events, Email inbox)
  - **1 custom inline (Commitments)** — defined in `commitments-mcp.ts`
    via `defineMockService`. Off-catalog primitive demonstrated on a
    real template.
  - **1 backend-as-MCP (Jobs)** — `@floe/jobs` runner exposed via
    `mountJobsMcp` so the LLM can `mcp__jobs__enqueue` long work,
    `mcp__jobs__get` status, and surface results in a later turn.
    Fills the gap left by Flue's sync `task()` and Agno Team's
    leader-blocks-on-members default. See `jobs.ts`.
- ✅ Four **strategic-context markdown files** auto-loaded each turn:
  - `strategic-priorities.md` — what matters this quarter / what NOT
    to surface
  - `key-relationships.md` — board / customers / direct reports / etc.
  - `communication-norms.md` — voice + polish bar by output type
  - `okrs-current.md` — quarterly OKRs with RAG colors
- ✅ **Long-running memory** with 1500-token preload — CoS benefits
  from remembering org state across every turn
- ✅ **Web + Slack** channels
- ✅ Smoke test pins the wiring + the inline Commitments MCP

## Quick start

```sh
pnpm install
cp templates/chief-of-staff/.env.example templates/chief-of-staff/.env
# Set OPENAI_API_KEY (or your provider key) + LEADER_NAME/LEADER_EMAIL in .env

pnpm --filter chief-of-staff dev
```

You'll see:

```
[chief-of-staff:mocks] notion      → http://localhost:4401/mcp
[chief-of-staff:mocks] linear      → http://localhost:4402/mcp
[chief-of-staff:mocks] calendar    → http://localhost:4403/mcp
[chief-of-staff:mocks] email       → http://localhost:4404/mcp
[chief-of-staff:mocks] commitments → http://localhost:4405/mcp (inline custom)
[chief-of-staff] listening on http://localhost:3150
```

### Try it

**Exec brief for an upcoming meeting:**
```sh
curl -N -X POST http://localhost:3150/agents/web/cos-1 \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"message":"Brief me on Tuesdays Q3 planning kickoff — context, recent activity, what to drive","metadata":{"userId":"u_carol"}}'
```

The bot delegates to `exec-briefer`, pulls the calendar event, scans
recent emails from attendees, checks open Linear tickets, returns a
structured Context / Recent activity / Open from prior / Recommended
ask brief.

**Draft a board update:**
```sh
curl -N -X POST http://localhost:3150/agents/web/cos-1 \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"message":"Draft me a 1-page board update for next month — pull the OKR status, the wins, and the challenges","metadata":{"userId":"u_carol"}}'
```

The `comms-drafter` reads `communication-norms.md` (3 wins + 3
challenges + 1 ask format), pulls the OKR status from
`okrs-current.md`, drafts in the leader's voice (specific numbers,
"—C" sign-off, no AVOID phrases).

**Track commitments:**
```sh
curl -N -X POST http://localhost:3150/agents/web/cos-1 \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"message":"Whats overdue and whats due this week","metadata":{"userId":"u_carol"}}'
```

The `commitment-tracker` hits the inline Commitments MCP, returns
grouped-by-due-date results with 🔴🟡🟢 colors.

**Log a new commitment:**
```sh
curl -N -X POST http://localhost:3150/agents/web/cos-1 \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"message":"Log that I told Marc I would send the updated Q3 forecast by Friday","metadata":{"userId":"u_carol"}}'
```

Calls `mcp__commitments__log_commitment` and confirms.

## Background workers — the killer pattern for a CoS

Most agent frameworks (Flue's `task()`, Agno's Team) block the user's
turn while a delegated agent runs. That's wrong for a CoS: "deep-dive
on the Globex security review with the customer team" is a 5-minute
task. The leader shouldn't sit there waiting.

This template wires `@floe/jobs`, exposed as `mcp__jobs__*`. The CoS
detects long-running asks, enqueues a job, returns immediately, and
the user keeps talking. Later turns surface results.

**Live-verified end-to-end with `gpt-4.1-mini`** (real LLM, real
multi-MCP execution):

```sh
# TURN 1 — enqueue (11.4s, no inline wait)
curl -N -X POST http://localhost:3150/agents/web/cos-jobs-1 \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"message":"I need a deep dive on where we stand with Globex — pull email + Linear + Notion + open commitments. This is for board prep, take your time but kick it off NOW.","metadata":{"userId":"u_carol"}}'
# → "I've kicked off a deep research job ... I'll notify you once complete."

# TURN 2 — completely unrelated question while the job runs (6.9s)
curl -N -X POST http://localhost:3150/agents/web/cos-jobs-1 \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"message":"While that runs, whats on my calendar for Friday","metadata":{"userId":"u_carol"}}'
# → "You have no events scheduled on your calendar for Friday."
# (The deep-researcher is still working in parallel.)

# TURN 3 — ask for results (6.8s)
curl -N -X POST http://localhost:3150/agents/web/cos-jobs-1 \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"message":"Any results from the Globex research job yet","metadata":{"userId":"u_carol"}}'
# → "The deep research is complete: ... [structured findings with
#    sources cited; honestly notes 'no Globex emails found' when the
#    seed data has none rather than hallucinating]"
```

The wiring lives in `jobs.ts` (~85 LOC):
- `createJobRunner({ concurrency: 3, perform })` — `perform` spawns the
  job on a fresh session id (`job-<jobId>`) with a `BACKGROUND JOB —
  act as the <worker> role` prompt prefix
- `mountJobsMcp(runner, { port })` exposes the runner as an MCP server
  the LLM can hit as `mcp__jobs__enqueue` / `get` / `list` / `cancel`

**Production hardening checklist** (when you fork):
- Swap `InMemoryJobStore` for a libSQL/Postgres store (`@floe/jobs`
  ships the `JobStore` interface)
- Register an `onComplete` listener that fires a Slack DM / webhook
  when a long job finishes (so the leader doesn't have to ask)
- Cap `concurrency` to your provider's rate limits
- Add `AbortSignal` plumbing in `perform` if you need in-flight cancel
  (v1 only cancels queued jobs)

## The strategic-context files: making the bot YOURS

The 4 markdown files in `knowledge/` are the bot's persistent context
(in addition to memory). **Edit these and the bot reflects your org
within minutes** — BM25 reloads them each turn; no restart needed.

| File | What goes in it |
|---|---|
| `strategic-priorities.md` | The 3 things that matter this quarter + the 5 things that DON'T (counter-intuitively important — keeps the bot from surfacing distractions when you ask "what's important") + your energy/attention model + send-vs-draft per audience |
| `key-relationships.md` | Board, customers, direct reports, cross-functional partners — names + roles + style preferences ("Marc wants data up front", "Sarah prefers Notion comment over email") |
| `communication-norms.md` | Your voice + polish bar per output type (board > customer > internal > Slack) + AVOID phrases + your actual phrases |
| `okrs-current.md` | Current quarter OKRs with RAG colors. Refresh weekly. The bot uses these for board updates + status checks. |

## The custom Commitments MCP — read this if you need a domain not in the bundled catalog

`commitments-mcp.ts` is **70 LOC** that defines a brand-new MCP
service using `defineMockService` + `mountMockMcp` from
`@floe/mock-services`. The bundled mocks (Notion, Linear, Calendar,
Email, etc.) don't cover "commitments the leader has made" — so
rather than stretching Linear tickets to mean two things, this
template defines its own.

**Pattern to copy** when you need a domain none of the bundled mocks
cover (sales forecasts, brand assets, internal wiki — anything):

```ts
const svc = await defineMockService<YourRowType>({
  name: 'your_domain',
  seed: [/* ... */],
  operations: {
    list_X: { description, input: v.object({...}), handler: (args, store) => {...} },
    // ...
  },
});
return mountMockMcp(svc, { port });
```

The mounter is generic; the schema + ops are bespoke. The tool surface
appears to the LLM as `mcp__your_domain__list_X` etc. Zero JSON-RPC
plumbing, zero hand-rolled HTTP.

## Swapping mocks for real services

When you're ready to swap to your real Notion / Linear / Calendar /
Email:

1. Replace each `mountXxx` call in `mocks.ts` with config pointing at
   your real MCP server's URL.
2. Update the `mcp: [...]` entries in `floe.config.ts` to point at
   your real-server config (Authorization headers etc).
3. **For Commitments**: in production you'd back this with a real
   Linear project (one ticket per commitment), or a small DB you
   expose via an MCP server. The schema in `commitments-mcp.ts` is the
   contract; the storage is up to you.

**Send-vs-draft enforcement at the integration layer**: the bundled
Email mock has only `draft_reply` (no `send_message`). When you wire
real Gmail/Outlook, restrict OAuth scopes to `gmail.compose` and OMIT
`gmail.send`. The bot literally cannot send — defense in depth beyond
the prompt rules.

## Project layout

```
templates/chief-of-staff/
├── floe.config.ts             — 4 roles + 6 MCPs
├── server.ts                  — Web + optional Slack
├── mocks.ts                   — 4-mock lifecycle (bundled) + 1 inline custom
├── commitments-mcp.ts         — Inline custom MCP (defineMockService demo)
├── jobs.ts                    — @floe/jobs runner + mountJobsMcp wiring
├── knowledge/
│   ├── strategic-priorities.md
│   ├── key-relationships.md
│   ├── communication-norms.md
│   └── okrs-current.md
├── AGENTS.md                  — Auto-loaded routing + style rules
├── test/smoke.test.ts         — Wiring + roles + inline-MCP + jobs round-trip
├── .env.example
├── package.json
├── tsconfig.json
└── README.md (you are here)
```

## When NOT to use this template

- **You're an IC, not supporting a leader**: use `knowledge-worker/`
  — it's personal AI, not org coordination.
- **You're building a customer-facing bot**: use `ops-bot/` (B2B
  internal), `hearth-bot/` (B2C subscription), or `cedar-health/`
  (high-stakes).
- **You need real send-on-the-leader's-behalf** (auto-replies to
  customers etc): don't. The draft-not-send discipline is the
  single most important guardrail for a CoS bot. Resist the
  temptation to "automate one more step".

## Tests

```sh
pnpm --filter chief-of-staff test
```

Smoke test only — proves the boot wiring stays correct AND the inline
Commitments MCP actually responds. For real eval, write scenarios in
`test/*.test.ts` using `@floe/bench-harness`.
