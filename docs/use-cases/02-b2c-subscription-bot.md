# Use case 02 — B2C subscription support (meal kit, voice + web)

**Wedge**: B2C consumer support. Voice (phone) and web widget channels.
Action-taking on every turn; retention is the high-stakes flow.

**Status**: ✅ Built — see [`templates/hearth-bot/`](../../templates/hearth-bot/).
The template ships a runnable voice + web meal-kit subscription bot
with `retention` + `box-issue` specialist roles and mock Subscription
/ Order MCP servers.

Markers in this doc:
- ✅ shipped today
- ✅ canonical v1 shape (Assistant + roles + webAdapter)
- 🌳 wired but unused in shipped examples

---

## The scenario

**"Hearth"** — a meal kit subscription. ~400k subscribers, 3% weekly
contact rate, two entry points:

1. **Web widget** (in-app, post-login) — for skip-week, address change,
   pause, cancel
2. **Phone line** — same things, but customers calling are usually
   time-pressed ("I won't be home tomorrow, change the address") or
   frustrated ("the box arrived rotten")

Same bot brain, two channels. Real actions on each turn: hit the
subscription API, send refunds, schedule pickups, modify routes.
Retention specialists pick up cancellation attempts. Voice users get
higher-tier escalation faster (different SLA).

## What the customer sees

**Web widget**: types "skip next week" → reply appears in 1s → "Done.
Your delivery for May 30 is paused. You're saved $84. Resume? [button]"

**Phone**: caller says "Hey, uh, can you skip next week for me" → 500ms
after they stop talking, voice replies "Got it — pausing your May 30
delivery, saves you $84. Want me to also skip the week after?"

Same intent, same backend action, **same conversation primitive in
Floe**. The channels differ only in modality.

## The code

```ts
// assistant.ts (~60 LOC)
import { Assistant } from '@floe/runtime';
import { localSandbox } from '@floe/runtime/sandbox/local';
import { hybridKnowledge } from '@floe/runtime/knowledge/hybrid';
import { openaiEmbedder } from '@floe/runtime/embedders/openai';
import { InMemoryVectorStore } from '@floe/runtime/vectorstores';
import { confidence, safety } from '@floe/runtime/validators';
import { LibsqlMemoryService } from '@floe/runtime/memory';
import { zendeskInbox } from '@floe/runtime/inbox/zendesk';  // 🔜 sibling of linearInbox

export const hearth = new Assistant({
  name: 'hearth-support',

  // ✅ Single host + named specialist roles (v1 BLUEPRINT — shipped)
  systemPrompt: `You are Hearth's subscription assistant. Help with
    skip-week, address changes, pause, cancel, and box issues. Always
    act first via tools, then confirm in one short sentence. Never
    promise refunds without using the refund tool. If the caller
    sounds upset or asks for a human, escalate immediately.`,

  roles: {
    'retention': {
      instructions: `You are a retention specialist. The customer is
        cancelling. ONE empathetic acknowledgement, then ONE relevant
        offer based on their tenure + cancel reason (loaded from memory).
        Never beg. Never offer more than one alternative.`,
      thinkingLevel: 'high',
    },
    'box-issue': {
      instructions: `You handle damaged/missing/spoiled boxes. Ask
        what was wrong, file the issue, decide credit vs reship. Cap
        credit at $50 without escalation.`,
    },
  },

  knowledge: [
    hybridKnowledge({
      name: 'policies',
      paths: ['knowledge/**/*.md'],   // pause policy, refund matrix, dietary
      embedder: openaiEmbedder({ apiKey: process.env.OPENAI_API_KEY!, model: 'text-embedding-3-small' }),
      vectorStore: new InMemoryVectorStore({ dimensions: 1536 }),
    }),
  ],

  validators: [
    safety({ blockBelow: 0.3 }),                      // refuse abusive / off-topic
    confidence({ disambiguateBelow: 0.55 }),          // ask clarifying Q when unsure
  ],

  resolveUserId(input) {
    return input.metadata?.subscriberId as string | undefined;
  },

  lifecycle: {
    idleAfterMs: 5 * 60 * 1000,         // voice closes fast; chat lingers
    escalateAfterFailedTurns: 2,
  },

  handoff: {
    policy: ({ metrics, lastUserMessage, channel }) => {
      if (/speak to (a |the )?human|talk to (someone|a person)/i.test(lastUserMessage)) return 'escalate';
      if (channel.name === 'voice' && metrics.validatorBlocks >= 1) return 'escalate';  // voice escalates faster
      if (metrics.confidence < 0.4) return 'escalate';
      return 'continue';
    },
    to: zendeskInbox({
      apiToken: process.env.ZENDESK_TOKEN!,
      brand: 'hearth',
      // Voice escalations get higher priority + dispatched to phone-trained agents
      routeBy: (ctx) => ctx.channel === 'voice' ? { group: 'phone-team', priority: 'high' } : { group: 'web-team', priority: 'normal' },
    }),
  },

  // Channel-specific overlays — same conversation, different shape
  channels: {
    voice: {
      // Voice mode: shorter replies, forced sequential tool use,
      // sentence-boundary streaming for TTS
      systemPromptOverlay: `Reply in one sentence. Pause between actions.`,
      maxResponseTokens: 80,
      transcriptionCorrection: 'aggressive',  // STT garbles meal names
    },
    web: {
      // Web: can render lists, buttons, links
      systemPromptOverlay: `You can use markdown (links, bullet lists).`,
    },
  },

  // ✅ Deployment fields live on the Assistant
  sandbox: localSandbox(),
  model: 'anthropic/claude-sonnet-4-6',
  mcp: [
    { name: 'subs',     url: process.env.SUBS_MCP_URL!,    headers: { Authorization: `Bearer ${process.env.SUBS_TOKEN}` } },
    { name: 'billing',  url: process.env.BILL_MCP_URL!,    headers: { Authorization: `Bearer ${process.env.BILL_TOKEN}` } },
    { name: 'shipping', url: process.env.SHIP_MCP_URL!,    headers: { Authorization: `Bearer ${process.env.SHIP_TOKEN}` } },
  ],
  memory: {
    service: new LibsqlMemoryService({ url: process.env.TURSO_URL!, authToken: process.env.TURSO_TOKEN! }),
    preload: { maxTokens: 600 },                  // tenure, prior cancels, dietary prefs, recent issues
    ingest:  { auto: true, strategy: 'extract' }, // LLM extracts facts post-turn
  },
  compaction: { reserveTokens: 8000, keepRecentTokens: 4000 },
  rateLimit: ipRateLimit({ perMinute: 20 }),      // per-IP guardrail
});

export default hearth;
```

### `server.ts`

```ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { webAdapter } from '@floe/adapter-web';
import { elevenLabsAdapter } from '@floe/adapter-elevenlabs';
import { hearth } from './assistant.ts';

const app = new Hono();
app.route('/', webAdapter({ assistant: hearth }));
app.route('/voice', elevenLabsAdapter({ assistant: hearth, voiceId: 'rachel' }));

serve({ fetch: app.fetch, port: 3000 });
```

## The voice integration boundary (where Floe stops and the speech engine starts)

Floe is **brain-only**. STT/TTS is somebody else's job.

```
┌────────────────────────────────────────────────────────────────┐
│  Phone call → Twilio / Vonage / LiveKit                         │
│     │                                                            │
│     ▼                                                            │
│  Speech engine (ElevenLabs Conversational AI, Cartesia, OpenAI │
│  Realtime, Vapi, Pipecat, etc.)                                 │
│     - STT (continuous, partial transcripts)                     │
│     - Silence detection → end-of-turn signal                    │
│     - Barge-in detection → emit cancel                          │
│     - TTS (streams chunks back as audio)                        │
│     │                                                            │
│     ▼  HTTP POST per finalized user turn                        │
│  Floe voice channel: parseInbound → user_text_sent              │
│     │                                                            │
│     ▼  orchestrator (same brain as web)                         │
│     │   - validators                                             │
│     │   - LLM streams sentence-by-sentence                      │
│     │   - tool calls fire (Subs/Billing/Shipping MCP)           │
│     │                                                            │
│     ▼  SSE stream back to speech engine                         │
│  Speech engine TTSs each sentence as it arrives                 │
│     │                                                            │
│     ▼  Audio back to caller's phone                             │
└────────────────────────────────────────────────────────────────┘
```

Two cancellation layers, intentionally:

- **Barge-in cancel** (audio layer, speech engine): caller starts
  talking mid-TTS → engine stops playback immediately + sends cancel
  signal to Floe
- **Turn-level interrupt** (Floe's turn-registry, the C work): if a new
  user turn arrives before the prior one finishes its LLM call, Floe
  aborts the in-flight call cleanly

The speech engine handles the millisecond-level audio behavior; Floe
handles the turn-level brain behavior. Cleanly decoupled.

## One turn end-to-end (voice cancel attempt)

Caller: *"Yeah, I'd like to cancel my subscription."*

```
Speech engine → POST /agents/voice/<call-sid>
  body: { type: 'user_text_sent', content: "I'd like to cancel my subscription",
          metadata: { subscriberId: 'sub_8821', callSid: 'CA...' } }

──► prepareTurn
    • Rate limit pass
    • beginTurn(callSid, requestSignal) — barge-in feeds into requestSignal
    • init harness w/ MCP tools (subs, billing, shipping) + sandbox
    • Load state: subscriber tenure 14 months, 0 prior cancels, vegetarian
    • Memory preload: "Reported damaged box on 2026-04-12, credited $40"
    • No triage call (one host)

──► retrieve
    • Hybrid knowledge on /policies → retention.md (cancel flow, offers matrix)
    • Memory injected into system prompt

──► respond
    • Voice channel overlay forces: one-sentence reply, sequential tool use
    • LLM round 1 (streams to TTS sentence by sentence):
        "I can help with that — let me pull up your subscription."
        → tool: mcp__subs__getSubscription(sub_8821)
                returns { plan: 'family-4', tenure: 14mo, lastBox: '2026-05-15' }
    • LLM decides this is a retention moment → task({ role: 'retention',
        prompt: 'Cancel attempt: 14mo customer, family-4 plan, one prior
        damage credit, no other complaints in memory.' })
        → retention role (own context, isolated) returns recommended offer:
          "skip the next 2 weeks at no cost"
    • LLM round 2 (streamed):
        "Before I cancel, I can pause your account for two weeks at no
         cost — would that help, or shall I go ahead and cancel?"
    • postLLM confidence validator: 0.82 → pass

──► finalize
    • Memory ingest: "Cancel attempt → retention offer made (2-week pause).
       Awaiting customer response."
    • Persist state: turnCount++, lifecycle still 'active'
    • Transcript append
    • TurnMetrics:
        runId: 'run_a8d2', channel: 'voice', isVoice: true, ms: 2200,
        llm: 1400, tasks: { count: 1, totalMs: 600 }, compaction: { count: 0 },
        models: ['anthropic/claude-sonnet-4-6'], producedReply: true,
        validatorVerdict: 'ok', interrupted: false
```

Caller responds: *"Yeah pause it."* → next turn → tool:
`mcp__subs__pauseSubscription` → "Paused until June 15. We'll text you
the day before." → SMS via shipping MCP → conversation lifecycle moves
to `idle` after 5 min.

If the caller had said *"Just cancel it"* → retention role would
recommend "honor request, no second ask" → tool:
`mcp__subs__cancelSubscription` → "Cancelled. Your last box ships May
25. Sorry to see you go — if you ever want to come back, your
preferences are saved."

If the caller said *"Just put me through to a human"* → handoff policy
regex match → escalation fires → Zendesk ticket created with full
transcript + memory context + tagged for phone-team high-priority →
speech engine bridges call to next available retention specialist with
whisper-introduction.

## Where the two channels actually differ (and where they don't)

| Concern | Web widget | Voice | Where handled |
|---|---|---|---|
| Inbound shape | JSON body | webhook from speech engine | Channel adapter |
| Turn boundary | Send button | STT silence detection | Speech engine (voice) / button (web) |
| Streaming | Optional (chunks → text) | **Required** (sentence chunks → TTS) | Both natively support |
| Interrupt | New message | Barge-in audio | Turn registry (Floe) + audio cancel (engine) |
| Response shape | Markdown OK | Plain prose, short | Channel overlay in config |
| Tool use | Parallel OK | Sequential forced | Channel overlay |
| Escalation SLA | Normal | High-priority | Handoff `routeBy` |
| Disfluencies in input | None | "um, like, uh" | `transcriptionCorrection: 'aggressive'` |
| Identity | Auth header (logged in user) | Phone number → subscriber lookup | Channel `parseInbound` |
| Persistence | Same Turso store | Same Turso store | Floe's session store |
| Memory | Keyed by subscriberId | Keyed by subscriberId | Same `resolveUserId` |
| **Brain** | **Same** | **Same** | **Floe orchestrator** |

The brain is one piece of code. The channels handle modality
translation. That's the whole point — Floe owns the conversation
primitive; channels are pluggable I/O.

## Where Floe stops (what you have to bring)

| Layer | Who | Why not Floe's job |
|---|---|---|
| Web widget UI (chat bubble component) | Vercel AI SDK `useChat` or your own React | Frontend opinion; Floe ends at the HTTP API |
| Voice gateway (Twilio/LiveKit/Vapi/Pipecat) | Pick one | Telephony is its own complexity |
| Speech engine (STT/TTS) | ElevenLabs / Cartesia / OpenAI Realtime / Deepgram | Audio ML; not our wheelhouse |
| Subscription API (Stripe / your billing system) | Your own service exposed via MCP | Business logic — bring your own |
| Identity (who is this caller?) | Your auth layer | Bring your own |
| Retention specialist tool (the human side) | Zendesk / Front / Intercom / custom | Inbox port handles handoff *to* them |

Floe is the brain + the runtime around it. The mouth/ears are speech
engines. The hands are MCP tools to your business systems. The eyes
(the widget UI) are AI SDK or your own React. The escalation desk is
Zendesk/Linear.

## What this gets you that stacking SDKs doesn't

1. **Same brain, two channels** — without Floe, you'd write two
   near-duplicate orchestrators (one for HTTP/web, one for the voice
   webhook) and they'd drift apart in 3 months
2. **Channel-aware response shape** — voice mode forcing short
   single-sentence replies + sequential tool use without rewriting the
   prompt manually per call
3. **Memory across channels** — customer starts on web Monday, calls
   Tuesday — bot remembers Monday's context because `subscriberId` keys
   both
4. **Two-level cancel** — barge-in (audio, engine) + turn supersession
   (brain, Floe) — both work, neither corrupts the other
5. **Per-channel handoff routing** — voice escalations go to phone-team
   high-priority; web to web-team normal — one config block
6. **Per-turn audit row** — every action gets a TurnMetrics with
   channel, validator verdict, delegation count, interruption flag —
   feeds Looker/Metabase for "where do we lose retention attempts by
   channel?"
7. **Validators that fire BEFORE tools execute** — refund safety,
   abusive caller, off-topic — keep the bot from making expensive
   mistakes

Each of these is a non-trivial slice of work you'd otherwise own.

## What to build to prove this works

Three Floe-built artifacts together:

1. `examples/hearth-bot/` — the config above + stub Subs/Billing/Shipping
   MCP servers (like `mcp-bot`'s stub)
2. `examples/hearth-bot/web/` — a React widget calling `floe.fetch`
   (uses Vercel AI SDK `useChat`)
3. `examples/hearth-bot/voice/` — a thin glue script that connects to
   ElevenLabs Conversational AI (or Vapi) and points it at the same
   Floe deployment — proving "same brain, two channels" empirically
