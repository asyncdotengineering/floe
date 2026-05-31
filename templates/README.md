# Templates

Clone-and-go Floe templates. Each template is a complete, runnable
Floe deployment for a specific vertical use case — system prompt,
knowledge base, mock backends, channel adapters, validators, memory
config, tests, README, and a `.env.example`.

> 💬 **Want a chat UI to interact with these?** See
> [`apps/studio/`](../apps/studio/) — a thin Tanstack Start + Vercel
> AI Elements UI shell that connects to any template via a single
> `FLOE_AGENT_URL` env var. Mastra-Dev-Studio / Agno-UI shape for Floe.

## Templates vs. examples

| | `examples/<slug>/` | `templates/<slug>/` |
|---|---|---|
| Intent | Pedagogical demos of ONE feature | Production-shape starters you fork |
| Audience | "show me how a Floe flow works" | "build my real product on Floe" |
| Mocks | Inline ad-hoc | `@floe/mock-services` (swappable) |
| Channel wiring | Web only | Web + the channel(s) the use case needs |
| Persona | Generic | Vertical-specific (Acme IT, Hearth meal-kit, Cedar Health clinic) |
| Tests | Often live LLM | Smoke + deterministic guards |
| `.env.example` | Minimal | Complete |
| README | Quickstart | Quickstart + swap-to-real-services guide |

If you're learning Floe → start in `examples/`. If you're building a
product → fork a template.

## The 5 v1 templates

Three customer-facing templates (built from `docs/use-cases/`) plus
two personal-AI templates (knowledge-worker for ICs,
chief-of-staff for leaders).

### 1. [`ops-bot/`](ops-bot/) — Internal IT/HR operations (Slack + web)

B2B internal ops. Slack adapter (HMAC-signed Events API), 3 mock MCP
servers (Okta directory, Notion docs, Linear tickets), cross-session
memory keyed by Slack user id, knowledge base of policy + runbooks.

```sh
pnpm install
cp templates/ops-bot/.env.example templates/ops-bot/.env
# set OPENAI_API_KEY in .env
pnpm --filter ops-bot dev
```

→ [Use-case blueprint](../docs/use-cases/01-internal-ops-bot.md)
→ [Template README](ops-bot/README.md)

### 2. [`hearth-bot/`](hearth-bot/) — Meal-kit subscription support (voice + web)

B2C consumer support. Voice channel (generic speech-engine endpoint
+ Twilio direct), specialist roles (`retention` for cancellation,
`box-issue` for damaged deliveries), mock Subscription + Order MCP
servers, cross-channel memory bridge.

```sh
pnpm install
cp templates/hearth-bot/.env.example templates/hearth-bot/.env
# set OPENAI_API_KEY in .env
pnpm --filter hearth-bot dev
```

→ [Use-case blueprint](../docs/use-cases/02-b2c-subscription-bot.md)
→ [Template README](hearth-bot/README.md)

### 3. [`cedar-health/`](cedar-health/) — Clinic patient assistant (voice + web)

B2C high-stakes. Voice + web. **Runtime emergency keyword guard**
short-circuits the LLM with a scripted 911 reply for life-threatening
signals (zero LLM cost, deterministic). PII redaction validator,
identity-required nudge, 3 specialist roles (`scheduler`,
`triage-router`, `billing`), mock Patient FHIR + Rx + Billing.

```sh
pnpm install
cp templates/cedar-health/.env.example templates/cedar-health/.env
# set OPENAI_API_KEY in .env
pnpm --filter cedar-health dev
```

→ [Use-case blueprint](../docs/use-cases/03-b2c-clinic-bot.md)
→ [Template README](cedar-health/README.md)

> ⚠️ Cedar Health is a framework walkthrough, not a deployable medical
> bot. Real medical AI requires medical advisory board oversight,
> BAA-covered infrastructure, FDA navigation, malpractice
> considerations. Floe shows the SHAPE; the regulatory scaffolding is
> yours.

### 4. [`knowledge-worker/`](knowledge-worker/) — personal AI for cross-app work (web + Slack)

The "agent that works for you, not for your customers" use case.
Pulls cross-app context (Notion docs + Linear tickets + Calendar
events + Email inbox), 3 specialist roles (`researcher` /
`drafter` / `summarizer`), reads your style preferences + active
projects + people-context notes each turn, builds long-running
memory keyed to a single owner. **Bot drafts, you send.**

```sh
pnpm install
cp templates/knowledge-worker/.env.example templates/knowledge-worker/.env
# set OPENAI_API_KEY (and optionally Slack tokens) in .env
pnpm --filter knowledge-worker dev
```

→ [Template README](knowledge-worker/README.md)

(No `docs/use-cases/` entry — the personal-AI use case was added
after the original 3 customer-facing blueprints. The template is the
authoritative source.)

### 5. [`chief-of-staff/`](chief-of-staff/) — personal AI for ONE leader, coordinating across the org (web + Slack)

The CoS counterpart to `knowledge-worker`: works for a leader
(CEO/founder/CTO), coordinates across the whole org. 3 roles
(`comms-drafter` for board updates / all-hands / customer emails;
`exec-briefer` for pre-meeting briefs; `commitment-tracker` for
"what did the leader promise whom, what's slipping"). 5 MCPs —
4 bundled + **1 inline custom Commitments MCP defined via
`defineMockService`**, demonstrating the off-catalog primitive on a
real template. 4 strategic-context markdown files (priorities,
relationships, communication norms, OKRs) auto-loaded each turn.

```sh
pnpm install
cp templates/chief-of-staff/.env.example templates/chief-of-staff/.env
# set OPENAI_API_KEY + LEADER_NAME/LEADER_EMAIL in .env
pnpm --filter chief-of-staff dev
```

→ [Template README](chief-of-staff/README.md)

The difference from knowledge-worker: knowledge-worker's outputs go
to YOU; chief-of-staff's outputs go to the BOARD, CUSTOMERS,
all-hands. Polish bar is board-grade. Same primitives, different
audience.

## Shared infrastructure (all 5 templates lean on these)

- [`@floe/server-bootstrap`](../packages/server-bootstrap) — single-call
  HTTP bootstrap with metrics observer, openai-compat mux,
  graceful-shutdown, custom-route escape hatch
- [`@floe/mock-services`](../packages/mock-services) — 10 bundled mock
  MCP services (Okta, Notion, Linear, Subscription, Order, Patient
  FHIR, Rx, Billing, Calendar, Email) + `defineMockService` primitive
  for off-catalog domains
- [`@floe/jobs`](../packages/jobs) — **background-worker primitive**.
  Enqueue work, the runner processes it off the user's turn, the LLM
  hits `mcp__jobs__*` to check status / fetch results in later turns.
  Fills the gap left by Flue's sync `task()` and Agno Team's
  leader-blocks-on-members default. Used by `chief-of-staff` to
  background long deep-research jobs.
- [`@floe/adapter-slack`](../packages/adapter-slack) — Slack Events
  API channel adapter with HMAC signature verification
- [`@floe/adapter-voice`](../packages/adapter-voice) — generic
  speech-engine adapter (ElevenLabs, Vapi, Cartesia, Pipecat, OpenAI
  Realtime) + Twilio direct webhook
- [`@floe/bench-harness`](../packages/bench-harness) — live-server
  bench harness for assertion-driven evals

These are real packages — when you fork a template, the deps point at
workspace versions. For non-monorepo use, swap `workspace:*` for the
published version (when packages are published).

## Fork-and-go checklist (copying a template out of this monorepo)

1. Copy the template directory to your repo (e.g. `cp -r templates/ops-bot/ ../my-ops-bot/`)
2. Update `package.json`:
   - Change `"name"` to your project name
   - Change `"workspace:*"` to the published `^x.y.z` version of each Floe package
3. Update `tsconfig.json` `extends` to point at your own config (or copy the relevant compiler options)
4. Copy `.env.example` → `.env` and fill in
5. Update `floe.config.ts`:
   - Rewrite `systemPrompt` for your domain
   - Edit `knowledge/**/*.md` to match your real policies
6. Run `npm install`, then `npm run dev`. The mocks should come up.
7. One service at a time, replace each `mountXxx` call with a real MCP
   server config. The assistant prompt doesn't care.
8. Hook your real channel:
   - Ops-bot: a real Slack workspace (signing secret + bot token)
   - Hearth/cedar: a real speech engine (or Twilio number)
9. Add `observability: { sinks: [...] }` to capture per-turn metrics
10. Write real eval scenarios in `test/*.test.ts` using
    [`@floe/bench-harness`](../packages/bench-harness)
