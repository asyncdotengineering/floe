# Ops-bot — internal IT/HR operations template

A clone-and-go Floe template for an **internal ops bot**: handles
password resets, software requests, on-call escalations, policy
questions, and ticket filing. Slack-primary, web-secondary.

This is the runnable build of [`docs/use-cases/01-internal-ops-bot.md`](../../docs/use-cases/01-internal-ops-bot.md).

## What you get out of the box

- ✅ One **Floe Assistant** with system prompt, knowledge base, memory, validators
- ✅ Three **mock MCP servers** (Okta directory, Notion docs, Linear tickets)
  running in-process — no external accounts to register before you can `pnpm dev`
- ✅ **Slack adapter** with HMAC signature verification, ready to wire to a real workspace
- ✅ **Web channel** + OpenAI-compat routes for chat UIs and SDK clients
- ✅ **Cross-session memory** keyed by Slack user id (or web `userId`)
- ✅ **Knowledge base** of 4 starter policy/runbook markdown files
- ✅ **Smoke test** that the boot wiring stays correct

## Quick start

```sh
# Clone the monorepo, then from the repo root:
pnpm install
cp templates/ops-bot/.env.example templates/ops-bot/.env
# Edit templates/ops-bot/.env — at minimum set OPENAI_API_KEY (or your provider's key)

pnpm --filter ops-bot dev
```

You'll see:

```
[ops-bot:mocks] okta   → http://localhost:4001/mcp
[ops-bot:mocks] notion → http://localhost:4002/mcp
[ops-bot:mocks] linear → http://localhost:4003/mcp
[ops-bot] Slack adapter SKIPPED — set SLACK_SIGNING_SECRET + SLACK_BOT_TOKEN to enable.
[ops-bot] listening on http://localhost:3110
```

Hit it via OpenAI SDK / curl / a chat UI:

```sh
curl -N -X POST http://localhost:3110/agents/web/sess-1 \
  -H 'content-type: application/json' \
  -d '{"message": "I need staging DB access for the migration project — what do I do?"}'
```

The bot will look up your manager (mock Okta), pull the access policy
(local knowledge), file a Linear ticket (mock Linear), and reply with
the ticket link + ETA — all in one turn.

## Wiring Slack

In [api.slack.com/apps](https://api.slack.com/apps):

1. Create a new app
2. **Event Subscriptions** → enable, point to `https://your-host/slack/events`
3. **Subscribe to bot events**: `app_mention`, `message.im`
4. **OAuth & Permissions** → scopes: `app_mentions:read`, `chat:write`, `im:history`, `im:read`
5. **Install to workspace** → grab the Signing Secret + Bot Token

Add to `templates/ops-bot/.env`:

```sh
SLACK_SIGNING_SECRET=abc...
SLACK_BOT_TOKEN=xoxb-...
```

Restart `pnpm dev` — the adapter mounts automatically.

For local dev with Slack, use `cloudflared tunnel --url http://localhost:3110`
or `ngrok` to expose the local server to Slack's webhook.

## Swapping mocks for real services

When you're ready to swap in real Okta / Notion / Linear:

1. Wire your real MCP server (Linear ships one; for Okta/Notion you'll
   either build one or use a community MCP).
2. In `mocks.ts`, remove the corresponding `mount<X>` call.
3. In `floe.config.ts`, replace the entry in `mcp: [...]` with a
   real-server config:
   ```ts
   mcp: [
     { name: 'linear', url: process.env.LINEAR_MCP_URL!,
       headers: { Authorization: `Bearer ${process.env.LINEAR_TOKEN}` } },
     // ...
   ],
   ```
4. **Don't change the assistant prompt** — the bundled mock operations
   match common real-MCP operation names (e.g. `linear.create_issue`).
   If your real MCP has different names, update the prompt to match.

## Project layout

```
templates/ops-bot/
├── floe.config.ts           — Assistant definition + mocks wiring
├── server.ts                — HTTP server (web + Slack)
├── mocks.ts                 — Mock MCP lifecycle (Okta + Notion + Linear)
├── knowledge/
│   ├── policies/            — access, password reset, software request
│   └── runbooks/            — on-call rotation
├── AGENTS.md                — Auto-loaded into the system prompt
├── test/smoke.test.ts       — Boot wiring check (no LLM calls)
├── .env.example
├── package.json
├── tsconfig.json
└── README.md (you are here)
```

## What's NOT included

This is a TEMPLATE — not a production deployment. Bring:

- **Identity verification**: the Slack adapter trusts whoever Slack says
  the user is. For sensitive actions, wire your own verification step.
- **Real handoff**: the assistant currently replies "I'll file a ticket"
  — actually wire up the Linear API call (or use the @floe/inbox handoff
  port when it ships).
- **Observability**: add `observability: { sinks: [otelSink(...)] }` to
  the Assistant config.
- **Production model + thinking level**: defaults to `openai/gpt-4.1-mini`
  for fast/cheap dev; production typically wants `anthropic/claude-sonnet-4-6`
  with `thinkingLevel: 'medium'`.

## Tests

```sh
pnpm --filter ops-bot test
```

Smoke test only — proves the wiring doesn't break. For real eval, see
`packages/bench-harness` and write your own scenarios.
