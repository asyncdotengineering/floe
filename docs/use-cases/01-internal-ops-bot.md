# Use case 01 — Internal IT/HR ops bot

**Wedge**: B2B internal operations. Single-channel (Slack) primary,
web secondary. Action-taking dominant; pure-chat near zero.

**Status**: ✅ Built — see [`templates/ops-bot/`](../../templates/ops-bot/).
The template ships a runnable Slack + web ops bot with mock Okta /
Notion / Linear MCP servers. Clone, set `OPENAI_API_KEY`, run
`pnpm --filter ops-bot dev`.

Markers in this doc:
- ✅ shipped today
- ✅ canonical v1 shape (Assistant + roles + webAdapter)
- 🌳 wired but unused in shipped examples

---

## The scenario

**"Ops"** — a Slack bot for the IT team at a 200-person company. It
handles password resets, software requests, Linear/Jira ticket filing,
on-call escalation, and "where's the X policy" questions. Same
conversation can move from Slack to email when complex; on-call picks
up via Linear inbox; bot resumes with full context when on-call hands
back.

Real-world acceptance criteria:

1. Employee DMs Slack: "I need access to the staging database for the
   migration project"
2. Bot checks who they are (Okta MCP), pulls policy from Notion (MCP),
   files a Linear ticket (MCP) with the right approvers tagged
3. Bot replies in Slack with the ticket link + ETA
4. On-call gets the Linear ticket; resolves it; the resolution comment
   posts back to the original Slack thread
5. A week later, same employee DMs: "did my staging access expire?" —
   bot remembers the prior ticket, queries Linear, answers

## What the developer writes

### Step 1 — `floe.config.ts` (~40 LOC)

```ts
// assistant.ts
import { Assistant } from '@floe/runtime';
import { localSandbox } from '@floe/runtime/sandbox/local';
import { workspaceBm25 } from '@floe/runtime/knowledge/workspace-bm25';
import { InMemoryMemoryService } from '@floe/runtime/memory';
import { confidence } from '@floe/runtime/validators';
import { linearInbox } from '@floe/runtime/inbox/linear';

export const ops = new Assistant({
  name: 'ops',

  // ✅ v1 BLUEPRINT: a single host role + named specialist roles
  // (replaces today's defineAgent + agents[] + triage subsystem)
  systemPrompt: `You are the IT operations bot. Help employees with
    access requests, software, and policy questions. Use the available
    roles (via task()) to delegate when a request needs specialist
    judgment. Always file a ticket for any access change.`,

  roles: {
    'access-approver': {
      instructions: `You evaluate access requests against policy.
        Cite the policy section. Recommend approve / deny / escalate-to-human.`,
      thinkingLevel: 'high',  // careful reasoning for access decisions
    },
    'on-call-summarizer': {
      instructions: `You summarize a conversation into a Linear ticket
        body — context, ask, urgency, suggested resolution.`,
    },
  },

  // ✅ Knowledge from a Notion export checked into the repo
  knowledge: [
    workspaceBm25({
      name: 'policies',
      paths: ['knowledge/policies/**/*.md'],
      chunkSize: 600,
    }),
  ],

  // ✅ Per-turn validators
  validators: [
    confidence({ disambiguateBelow: 0.6 }),  // ask clarifying Q if uncertain
  ],

  // ✅ Cross-session memory keyed by Slack user ID
  resolveUserId(input) {
    return input.metadata?.slackUserId as string | undefined;
  },

  // ✅ Lifecycle thresholds + handoff
  lifecycle: {
    idleAfterMs: 30 * 60 * 1000,        // 30 min no reply → idle
    escalateAfterFailedTurns: 2,        // 2 validator-blocks → escalate
  },
  handoff: {
    policy: 'confidence-below-0.4-or-explicit',
    to: linearInbox({
      apiKey: process.env.LINEAR_API_KEY!,
      teamId: 'IT',
      defaultPriority: 2,
    }),
  },

  // ✅ Deployment fields live on the Assistant
  sandbox: localSandbox(),
  model: 'anthropic/claude-sonnet-4-6',

  // ✅ Real MCP integration — Okta + Notion + Linear all reachable
  mcp: [
    { name: 'okta',   url: process.env.OKTA_MCP_URL!,   headers: { Authorization: `Bearer ${process.env.OKTA_TOKEN}` } },
    { name: 'notion', url: process.env.NOTION_MCP_URL!, headers: { Authorization: `Bearer ${process.env.NOTION_TOKEN}` } },
    { name: 'linear', url: process.env.LINEAR_MCP_URL!, headers: { Authorization: `Bearer ${process.env.LINEAR_TOKEN}` } },
  ],

  memory: {
    service: new InMemoryMemoryService(),   // Turso-backed in prod
    preload: { maxTokens: 800 },
    ingest:  { auto: true, strategy: 'raw' },
  },

  compaction: { reserveTokens: 8000, keepRecentTokens: 4000 },
});

export default ops;
```

### Step 2 — `server.ts` (~10 LOC)

```ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { webAdapter } from '@floe/adapter-web';
import { slackAdapter } from '@floe/adapter-slack';
import { ops } from './assistant.ts';

const app = new Hono();
app.route('/', webAdapter({ assistant: ops }));
app.route('/slack', slackAdapter({ assistant: ops, signingSecret: process.env.SLACK_SECRET! }));

serve({ fetch: app.fetch, port: 3000 });
console.log('[ops-bot] :3000');
```

That's it. Two files, ~50 LOC. Deploys to Node, Vercel, CF Workers, Fly,
Render — same code.

## What happens on the wire (one turn)

User in Slack: *"I need staging DB access for migration project"*

```
Slack POST → /agents/slack/<channel-id>  (signed by Slack secret)
   │
   ▼  Channel parses inbound: { user_text_sent, content, slackUserId }
   │
   ▼  prepareTurn:
   │    • rate limit check (none configured → pass)
   │    • init Flue harness with sandbox + MCP tools (okta, notion, linear)
   │    • acquire abort signal from turn-registry (interrupt if user types again)
   │    • load conversation state from Turso (turnCount: 14, active for 3 days)
   │    • resolveUserId('U07ABC') → "U07ABC" → memory preloads prior tickets
   │    • triage skipped (no agents[] anymore — single host)
   │
   ▼  retrieve:
   │    • workspace BM25 on knowledge/policies/access.md → 2 chunks
   │    • memory preload: "Filed ticket IT-142 last week for prod read access"
   │    • no procedures matched
   │
   ▼  respond:
   │    • pre-LLM validators: confidence pre-check
   │    • build system prompt: host instructions + roles registry + policy chunks + memory context
   │    • session.prompt({ tools: [...mcpTools, task], signal })
   │         LLM round-trip 1: "I'll check policy and the user's prior access"
   │            → tool call: mcp__notion__search("staging database access policy")
   │            → tool call: mcp__okta__getUser("U07ABC")
   │         LLM round-trip 2: invokes task({ role: 'access-approver', prompt: 'Should U07ABC get staging DB...' })
   │            (Flue spawns child run with the role overlay, isolated history)
   │            → role recommends: "approve with 7-day expiry, requires manager attestation"
   │         LLM round-trip 3: tool call: mcp__linear__createIssue({ team: 'IT', ... })
   │            → ticket IT-189 created
   │         LLM final: "Filed IT-189 with 7-day staging access pending your manager's sign-off. Link: ..."
   │    • post-LLM validators: confidence ≥ 0.6 → pass
   │
   ▼  finalize:
   │    • memory ingest: "U07ABC requested staging DB access → IT-189"
   │    • persist conversation state
   │    • transcript append (Slack will pull /history later for thread reconstruction)
   │    • TurnMetrics emit:
   │        turn 15, ms=4200, llm=2800, tasks={count:1,totalMs:1100},
   │        compaction={count:0}, validatorVerdict='ok',
   │        knowledge=[{source:'policies',chunks:2}],
   │        models=['anthropic/claude-sonnet-4-6'],
   │        interrupted=false
```

## What Floe handles for you (vs the LLM)

| Decision | Who | Why |
|---|---|---|
| Which conversation does this Slack DM belong to? | **Runtime** (channel routing by Slack channel ID) | Deterministic — no LLM cost |
| Which user is this? | **Runtime** (resolveUserId hook) | Same |
| Should we preload past memory? | **Runtime** (userId present + memory configured) | Same |
| Should we check the knowledge base? | **Runtime** (configured per conversation) | Same |
| Should we abort if the user types again? | **Runtime** (turn-registry supersession) | Same |
| Should this turn escalate to a human? | **Runtime** (handoff policy on validator verdict) | Same |
| Has this conversation gone idle? | **Runtime** (lifecycle timer) | Same |
| **Which specialist role to delegate to?** | **LLM** (calls task({role})) | Semantic — needs judgment |
| **What policy applies?** | **LLM** (reads injected knowledge chunks) | Semantic |
| **What's the action plan?** | **LLM** (tool calling) | Semantic |

This is the "don't make the LLM do everything" philosophy embodied. The
runtime owns mechanical decisions (routing, lifecycle, retrieval
gating, supersession, escalation triggers). The LLM owns semantic
decisions (intent, delegation, tool choice, response). No LLM triage
call to "pick an agent" — there is no agent to pick; there's one host
with roles it can invoke.

## Extending the use case

### Multi-channel: same conversation, Slack → email → voice

```ts
channels: {
  slack: slack({ signingSecret }),
  email: email({ inboundDomain: 'ops@acme.com' }),    // 🔜 not shipped yet
  voice: voice({ webhook: '/voice' }),                // 🌳 wired
},
```

When the employee escalates ("call me, this is urgent"), the
conversation ID stays the same; voice channel parses the inbound, the
SAME conversation state + memory + transcript carries through. The LLM
doesn't know it's now voice — the channel handles modality translation
(silence → end-of-turn, partial transcripts → user_text_sent stream).

### Human handoff that doesn't lose context

When the validator returns `confidence < 0.4`, the handoff policy fires:

```
HandoffPolicy → InboxPort.send({
  conversationId: 'C07ABC-thread-42',
  transcript: <last 20 turns>,
  summary: <auto-generated via the on-call-summarizer role>,
  links: { slack: 'https://acme.slack.com/...', tickets: ['IT-189'] },
}) → Linear creates an issue assigned to the on-call rotation
```

On-call resolves in Linear; the inbox adapter watches Linear's webhook;
the resolution posts back to the Slack thread via the channel — no
manual context-passing.

## What you DIDN'T have to write

| Concern | What Floe handles | What you'd write in raw AI SDK |
|---|---|---|
| Slack signed-request verification | Channel adapter | ~30 LOC HMAC plumbing |
| Per-user memory across sessions | Memory service + `resolveUserId` | DIY vector store + ingest pipeline |
| MCP tool wiring + connection pooling | `defaults.mcp: [...]` | ~80 LOC per MCP server |
| Mid-stream interrupt when user types again | Turn registry | A whole abort plumbing layer |
| Compaction when context grows | Flue (configured) | Manual summarization pass |
| Sub-agent delegation with isolated history | Flue `task` tool | DIY context fork |
| Cross-channel transcript continuity | Transcript store + `/history/*` routes | DIY |
| Per-turn observability digest | TurnMetrics + sinks (OTel/Braintrust) | DIY span wrapping |
| Tool isolation (a buggy MCP can't crash the conversation) | Sandbox factory + MCP failure isolation | DIY error boundaries |

Rough estimate: **~50 LOC of Floe config replaces ~2,000 LOC of
plumbing** you'd write yourself stacking Vercel AI SDK + Slack SDK +
your own memory + your own MCP wiring + your own escalation logic.

## What you'd ship next (the iteration loop the framework rewards)

1. **Add a procedure** — `procedures/access-policy.md` with frontmatter
   `triggers: ['access', 'permission', 'role']` — silently shapes
   every access-related reply with policy guardrails. No code change.
2. **Add a role** — `roles: { 'on-call-engineer': {...} }` — when an
   outage is mentioned, the host LLM delegates to
   `task({ role: 'on-call-engineer' })` for incident triage with
   elevated thinking.
3. **Wire a second knowledge source** — `hybridKnowledge` for the
   runbook wiki with embeddings. Multi-source retrieval is one config
   block.
4. **Plug Braintrust/OTel** — `observability: { sinks: [braintrust(...)] }`
   — every TurnMetrics row ships automatically. You see compaction
   frequency, delegation count, validator block rate, interruption rate
   per channel.
5. **Add an inbound webhook channel** — Jira creates a ticket → channel
   inbound fires a conversation turn → bot triages and routes. Channels
   aren't only human-facing.

## What this proves about the framing

This walkthrough wouldn't work for:

- **Pure chat** (AI SDK is enough; sandbox + MCP wiring is overhead)
- **Pure coding agent** (no human-bounded conversation; Flue directly)

It works specifically because the use case lives at the agentic-conversation
intersection: real actions (Linear tickets, Okta lookups, policy reads),
real human handoff (on-call), real multi-turn relationship (the bot
remembers IT-142 a week later), real channel pluralism (Slack today,
voice tomorrow). Floe's primitives map 1:1 to those needs.
