# Hearth-bot — B2C subscription support template

Clone-and-go Floe template for a **B2C subscription support bot** —
voice (phone) and web channels, real subscription actions every turn
(skip-week, address change, pause, cancel, refund), retention specialist
role for cancellations.

This is the runnable build of [`docs/use-cases/02-b2c-subscription-bot.md`](../../docs/use-cases/02-b2c-subscription-bot.md).

## What you get out of the box

- ✅ One **Floe Assistant** in `coordinate` mode with two specialist roles
  (`retention`, `box-issue`)
- ✅ Two **mock MCP servers** (Subscription + Order) running in-process
- ✅ **Voice adapter** — generic speech-engine endpoint (`/voice/turn`)
  + optional Twilio direct webhook
- ✅ **Web channel** + OpenAI-compat routes
- ✅ **Cross-session memory** keyed by `subscriberId` (web→voice context bridge)
- ✅ **Knowledge base** with refund matrix, cutoff policy, retention rules
- ✅ Voice overlay forces single-sentence replies + sequential tool use

## Quick start

```sh
pnpm install
cp templates/hearth-bot/.env.example templates/hearth-bot/.env
# Set OPENAI_API_KEY (or your provider's key) in .env

pnpm --filter hearth-bot dev
```

You'll see:

```
[hearth-bot:mocks] subscription → http://localhost:4101/mcp
[hearth-bot:mocks] order        → http://localhost:4102/mcp
[hearth-bot] listening on http://localhost:3120
```

### Test it from curl

```sh
# Web channel
curl -N -X POST http://localhost:3120/agents/web/sess-1 \
  -H 'content-type: application/json' \
  -d '{"message":"Hi, I need to skip next week", "metadata":{"subscriberId":"sub_alice_001"}}'

# Voice channel (what a speech engine would POST)
curl -X POST http://localhost:3120/voice/turn \
  -H 'content-type: application/json' \
  -d '{"sessionId":"call-CA-test","transcript":"Hi, I need to skip next week","metadata":{"subscriberId":"sub_alice_001"}}'
```

The voice endpoint returns sentence-shaped SSE chunks that pipe straight
to TTS.

### Wiring a real speech engine

`@floe/adapter-voice` is designed for any speech engine that does its
own STT + end-of-turn detection. Configure your engine to POST to
`/voice/turn` after each finalized user turn and stream-back the
`event: sentence` data lines to TTS.

Tested-shape engines: ElevenLabs Conversational AI, Vapi, Cartesia,
Pipecat, OpenAI Realtime. The Twilio direct path uses TwiML `<Gather>` +
`<Say>` if you want the cheapest PSTN integration.

### Wiring Twilio direct

In your Twilio console, point the voice number's webhook to
`https://your-host/twilio/voice` and set the same URL in `.env`:

```sh
TWILIO_VOICE_WEBHOOK_URL=https://your-host/twilio/voice
```

## Swapping mocks for real services

When you're ready to swap in a real Subscription API / Order DB:

1. Build (or reuse) an MCP server that exposes operations matching the
   names the assistant uses (`lookup_subscription`, `skip_week`, etc).
   The simplest path: wrap your existing REST API with a
   `defineMockService` call as a stop-gap — see `mocks.ts`.
2. In `floe.config.ts`, replace the entries in `mcp: [...]` with your
   real-server config:
   ```ts
   mcp: [
     { name: 'subscription', url: process.env.SUBS_MCP_URL!,
       headers: { Authorization: `Bearer ${process.env.SUBS_TOKEN}` } },
     // ...
   ],
   ```
3. Remove the corresponding `mountXxx` call from `mocks.ts`.

## Channel-specific behavior

The Assistant applies an overlay automatically per channel:

| | Voice (`/voice/turn`) | Web (`/agents/web/...`) |
|---|---|---|
| Reply length | 1-2 sentences, ~100 tokens cap | 2-3 sentences, markdown OK |
| Tool execution | Forced sequential | Parallel allowed |
| Streaming format | `event: sentence` SSE (TTS-ready) | OpenAI chat completion SSE chunks |
| Channel hint header | `X-Floe-Channel: voice` | (none) |

Same brain, two channels — Floe's whole positioning.

## Project layout

```
templates/hearth-bot/
├── floe.config.ts           — Assistant + roles + mocks wiring
├── server.ts                — HTTP server (web + voice + Twilio)
├── mocks.ts                 — Mock MCP lifecycle (Subscription + Order)
├── knowledge/policies.md    — Refund matrix + cutoff rules
├── AGENTS.md                — Auto-loaded system-prompt context
├── test/smoke.test.ts       — Boot wiring check
├── .env.example
└── README.md (you are here)
```

## What's NOT included

- **Phone-number identity verification**: the voice adapter trusts
  whatever `subscriberId` your speech engine passes. Wire a real
  phone-number-to-subscriber lookup at the gateway.
- **Real payment refund**: the mock just returns a synthetic refund id.
  Wire your real billing system's refund API.
- **Production observability**: add an `observability: { sinks: [...] }`
  entry to capture every TurnMetrics.
- **The retention/box-issue handoff to a human**: the role replies are
  the end of the road right now. Wire @floe/inbox when it ships, or
  add your own escalation tool.

## Tests

```sh
pnpm --filter hearth-bot test
```
