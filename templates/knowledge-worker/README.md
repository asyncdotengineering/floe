# Knowledge-worker — personal AI for cross-app work

A clone-and-go Floe template for a **personal AI assistant** — the
"agent that works for you, not for your customers" use case. Pulls
cross-app context (Notion + Linear + Calendar + Email), drafts replies
in your voice, summarizes meetings/threads in the shape you prefer,
researches across systems.

The 4th lighthouse alongside the 3 customer-facing templates
([ops-bot](../ops-bot/), [hearth-bot](../hearth-bot/),
[cedar-health](../cedar-health/)) — the same Floe primitives applied
to the personal-productivity wedge.

## What you get out of the box

- ✅ One **Floe Assistant** in `coordinate` mode with 3 specialist roles:
  - **`researcher`** — multi-step research spanning 2+ MCPs
    (`thinkingLevel: 'high'`)
  - **`drafter`** — reads your style preferences, drafts replies + paragraphs
  - **`summarizer`** — TL;DR + bullets in the shape you prefer
- ✅ Four **mock MCP servers** (Notion docs, Linear tickets, Calendar
  events, Email inbox), all running in-process with realistic seed data
- ✅ **Slack adapter** for DM-based quick lookups (optional)
- ✅ **Web channel** + OpenAI-compat for chat UIs and SDK clients
- ✅ **Long-running memory** keyed by your owner id — preferences and
  project state build up across every session
- ✅ **Personal knowledge base** of your own notes (style + active
  projects + people context) auto-loaded each turn via BM25

## Quick start

```sh
pnpm install
cp templates/knowledge-worker/.env.example templates/knowledge-worker/.env
# Set OPENAI_API_KEY in .env

pnpm --filter knowledge-worker dev
```

You'll see:

```
[knowledge-worker:mocks] notion   → http://localhost:4301/mcp
[knowledge-worker:mocks] linear   → http://localhost:4302/mcp
[knowledge-worker:mocks] calendar → http://localhost:4303/mcp
[knowledge-worker:mocks] email    → http://localhost:4304/mcp
[knowledge-worker] listening on http://localhost:3140
```

### Try it

**Catch me up on a project (researcher role):**
```sh
curl -N -X POST http://localhost:3140/agents/web/sess-1 \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"message":"Catch me up on Q3 planning — pull what I have in Notion, recent emails, and any open Linear tickets","metadata":{"userId":"u_me"}}'
```

The bot delegates to `researcher`, hits 2-3 MCPs, returns a TL;DR +
bulleted findings with cited sources.

**Draft a reply (drafter role):**
```sh
curl -N -X POST http://localhost:3140/agents/web/sess-1 \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"message":"Draft a reply to Carols Q3 kickoff email — I will pull the top-5 themes from the May synthesis doc and link the corresponding Linear tickets","metadata":{"userId":"u_me"}}'
```

The bot reads your style-and-prefs (no fluff, bare initial sign-off,
internal style for `acme.example` recipients), drafts the reply via
`email.draft_reply`, returns the draft for your review.

**Summarize (summarizer role):**
```sh
curl -N -X POST http://localhost:3140/agents/web/sess-1 \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"message":"Summarize my Wednesday — what is on my calendar and what needs my attention from email","metadata":{"userId":"u_me"}}'
```

## The 3 starter knowledge files

These ship in `knowledge/notes/` and are the bot's persistent personal
context (in addition to memory):

- **`style-and-prefs.md`** — how you want emails drafted, how
  summaries should be shaped, what NEVER to do without checking
- **`active-projects.md`** — what you're touching now, key deadlines,
  who owns what
- **`people-context.md`** — quick refs for the humans you work with —
  preferences, etiquette, slack-vs-email-vs-Linear routing

**Edit these to make the bot yours.** They auto-reload via BM25 every
turn; no restart needed.

## Why this template is different from the 3 customer-facing ones

| | ops-bot / hearth-bot / cedar-health | **knowledge-worker** |
|---|---|---|
| Audience | A company's customers / employees | YOU (one person) |
| Trust posture | Strict guardrails, escalate on anything unusual | Permissive — you trust the bot with your inbox |
| Memory | Per-user, scoped | Single-owner, builds up forever |
| Knowledge | Vertical-specific (policies, runbooks) | Your own notes + preferences |
| Style | One voice for many | Your voice, your way |
| Send vs draft | Bots act (file tickets, issue refunds) | Bot DRAFTS, you SEND |

The discipline shift: customer bots act on the company's behalf with
the company's voice; knowledge-worker bots prep work for YOU to act
with YOUR voice. The "draft, never send" rule is the line — break it
and you have a runaway agent emailing your CEO at 3am.

## Wiring Slack (optional)

If you want to DM the bot from Slack for quick lookups, see [the
ops-bot Slack setup](../ops-bot/README.md#wiring-slack) — same flow.
Add `SLACK_SIGNING_SECRET` + `SLACK_BOT_TOKEN` to `.env` and restart.

## Swapping mocks for real services

When you're ready to swap to your real Notion / Linear / Calendar / Email:

1. The Notion MCP server exists from Notion's official MCP hub; Linear
   ships their own; Calendar has community MCPs for Google/Microsoft;
   Gmail/Outlook MCPs are emerging.
2. In `floe.config.ts`, replace the entry in `mcp: [...]` with the real
   server's config:
   ```ts
   mcp: [
     { name: 'notion', url: process.env.NOTION_MCP_URL!,
       headers: { Authorization: `Bearer ${process.env.NOTION_TOKEN}` } },
     // ...
   ],
   ```
3. Delete the corresponding `mountXxx` from `mocks.ts`.
4. **The assistant prompt doesn't change** — the bundled mock op names
   match common real-MCP names (`search_pages`, `list_events`,
   `draft_reply`). If your real MCP names them differently, update
   the prompt to match.

**The Email MCP is the most sensitive swap.** Production Gmail/Outlook
integrations need OAuth scopes that limit what the bot can do —
preferably `gmail.compose` (drafts) WITHOUT `gmail.send`. Enforce
"draft, never send" at the OAuth scope layer, not just the prompt.

## Project layout

```
templates/knowledge-worker/
├── floe.config.ts            — Assistant + roles + 4 mocks
├── server.ts                 — Web + optional Slack
├── mocks.ts                  — 4-mock lifecycle
├── knowledge/notes/
│   ├── style-and-prefs.md
│   ├── active-projects.md
│   └── people-context.md
├── AGENTS.md                 — Auto-loaded into the system prompt
├── test/smoke.test.ts        — Boot wiring check
├── .env.example
├── package.json
├── tsconfig.json
└── README.md (you are here)
```

## Tests

```sh
pnpm --filter knowledge-worker test
```

Smoke test only — proves the boot wiring stays correct. For real eval,
see `packages/bench-harness` and write your own scenarios that exercise
the multi-MCP research path against your real seed data.
