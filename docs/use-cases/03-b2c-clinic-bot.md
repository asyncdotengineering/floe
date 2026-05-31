# Use case 03 — Healthcare clinic assistant (voice + web)

**Wedge**: B2C high-stakes. Voice (phone) and web widget channels. The
runtime-vs-LLM split must earn its keep — life-threatening signals
cannot route through the LLM.

**Status**: ✅ Built — see [`templates/cedar-health/`](../../templates/cedar-health/).
The template ships a runnable voice + web clinic bot with the
**runtime emergency keyword guard** (preLLM validator that
short-circuits the LLM with a scripted 911 reply for life-threatening
signals — zero LLM cost, deterministic, 18 boundary tests).

Markers in this doc:
- ✅ shipped today
- ✅ canonical v1 shape (Assistant + roles + webAdapter)
- 🌳 wired but unused in shipped examples

---

> **Scoping caveat**: this is a framework walkthrough, not a deployable
> medical bot. Real medical AI needs medical advisory board oversight,
> BAA-covered infrastructure, FDA navigation, malpractice
> considerations. Floe shows the *shape*; the regulatory scaffolding is
> out of scope. Stay inside this lane: scheduling, refills, billing,
> symptom routing (not diagnostic).

## The scenario

**"Cedar Health"** — multi-specialty clinic, 40 providers, 80k
patients. Two entry points:

1. **Patient portal widget** (behind SSO) — book, reschedule, refill,
   billing Qs
2. **Main phone line** (often elderly patients, accessibility, distress)
   — same things plus walk-in symptom check that routes appropriately

Real downstream actions per turn: EHR scheduling (FHIR), Rx system,
billing, insurance verifier. Three escalation lanes: routine human
scheduler, triage nurse line, and 911 instructions. The third is the
make-or-break: **the runtime — not the LLM — must catch
life-threatening signals.**

## The two-channel UX

**Web (logged-in patient)**: types "I need to reschedule my Wednesday
with Dr. Chen" → 1s → "Done. Moved to next Thursday 2:30pm — same
provider, same location. [Reschedule again]"

**Phone**: "Hi, I need to move my appointment with Dr. Chen" → 600ms →
"Sure — your Wednesday 9am with Dr. Chen. Want me to find the next
available slot, or do you have a specific day in mind?" → caller:
"Anytime Thursday afternoon" → 800ms → "I can do Thursday at 2:30pm,
same office. Should I book that?" → "Yes" → 500ms → "Booked. I'll text
you a reminder Wednesday."

## The code

```ts
// assistant.ts (~75 LOC — compliance adds a few)
import { Assistant } from '@floe/runtime';
import { localSandbox } from '@floe/runtime/sandbox/local';
import { hybridKnowledge } from '@floe/runtime/knowledge/hybrid';
import { openaiEmbedder } from '@floe/runtime/embedders/openai';
import { InMemoryVectorStore } from '@floe/runtime/vectorstores';
import { confidence, safety, piiRedaction } from '@floe/runtime/validators';
import { LibsqlMemoryService } from '@floe/runtime/memory';
import { genesysInbox } from '@floe/runtime/inbox/genesys';   // 🔜
import { emergencyKeywordGuard } from './guards/emergency.ts'; // YOUR code, ~30 LOC

export const cedar = new Assistant({
  name: 'cedar-health',

  systemPrompt: `You are Cedar Health's patient assistant. You help with
    APPOINTMENTS, PRESCRIPTION REFILLS (only routine refills the provider
    has pre-approved), BILLING questions, and routing symptom questions
    to the right care level. You DO NOT diagnose, interpret test results,
    or give medical advice. For any symptom question, use the
    triage-router role. Always confirm the patient's identity is verified
    before discussing anything specific.`,

  roles: {
    'scheduler': {
      instructions: `You handle appointment booking, reschedule, cancel.
        Always confirm provider, location, date, time before booking.
        For new patients without an established provider, route via PCP first.`,
    },
    'triage-router': {
      instructions: `You DO NOT diagnose. Match the patient's described
        symptom to one of: SELF_CARE (mild, common), SCHEDULE_VISIT
        (non-urgent, needs provider), NURSE_LINE (needs same-day clinical
        judgment), URGENT_CARE (needs care today), EMERGENCY (call 911).
        Use the published triage knowledge base. When in doubt, escalate.`,
      thinkingLevel: 'high',
    },
    'billing': {
      instructions: `You answer billing questions, explain charges, and
        help with payment plans. NEVER quote insurance coverage — refer
        to insurance verification tool output only.`,
    },
  },

  // Published nurse-triage protocols + scheduling rules + billing policy
  knowledge: [
    hybridKnowledge({
      name: 'protocols',
      paths: ['knowledge/triage/**/*.md', 'knowledge/policies/**/*.md'],
      embedder: openaiEmbedder({ apiKey: process.env.OPENAI_API_KEY!, model: 'text-embedding-3-small' }),
      vectorStore: new InMemoryVectorStore({ dimensions: 1536 }),
    }),
  ],

  validators: [
    // RUNTIME emergency guard — keyword + classifier, BEFORE any LLM call.
    // Bypasses normal flow entirely if matched. Pre-LLM phase = no LLM cost burned.
    emergencyKeywordGuard({
      phase: 'preLLM',
      onMatch: 'immediate-911-escalate',  // emits scripted reply + handoff
    }),
    // Refuse abusive / off-topic
    safety({ blockBelow: 0.3 }),
    // Redact patient-pasted SSN, full credit card, etc. before LLM sees it
    piiRedaction({ phase: 'preLLM', mode: 'mask' }),
    // Ask clarifying Q on low confidence
    confidence({ disambiguateBelow: 0.6 }),
  ],

  // Identity is set by channel — web has SSO, voice has phone+DOB verification
  resolveUserId(input) {
    return input.metadata?.verifiedPatientId as string | undefined;
  },

  lifecycle: {
    idleAfterMs: 10 * 60 * 1000,
    escalateAfterFailedTurns: 2,
  },

  handoff: {
    policy: ({ metrics, lastUserMessage, triageOutcome, channel }) => {
      if (triageOutcome === 'EMERGENCY') return 'escalate';
      if (triageOutcome === 'NURSE_LINE') return 'escalate';
      if (/speak to (a |the )?(nurse|doctor|human|person)/i.test(lastUserMessage)) return 'escalate';
      if (metrics.confidence < 0.4) return 'escalate';
      return 'continue';
    },
    to: genesysInbox({
      apiToken: process.env.GENESYS_TOKEN!,
      queues: {
        EMERGENCY:  { queue: 'nurse-stat',     priority: 10, prefixMessage: 'EMERGENCY — patient may need 911 advice' },
        NURSE_LINE: { queue: 'nurse-triage',   priority: 5 },
        scheduling: { queue: 'pat-scheduler',  priority: 1 },
        billing:    { queue: 'billing-team',   priority: 1 },
      },
    }),
  },

  channels: {
    voice: {
      systemPromptOverlay: `Reply in short sentences. Speak slowly. Pause
        between actions. If the caller seems distressed or confused,
        ask one simple question at a time.`,
      maxResponseTokens: 100,
      transcriptionCorrection: 'aggressive',
    },
    web: {
      systemPromptOverlay: `Use markdown lists and links when listing options.`,
    },
  },

  // ✅ Deployment fields live on the Assistant
  sandbox: localSandbox(),
  model: 'anthropic/claude-sonnet-4-6',

  mcp: [
    // EHR — FHIR-shaped reads/writes for appointments + provider lookup
    { name: 'ehr',         url: process.env.EHR_MCP_URL!,        headers: { Authorization: `Bearer ${process.env.EHR_TOKEN}` } },
    // Rx — pre-approved refills only; tool returns "needs provider review" otherwise
    { name: 'rx',          url: process.env.RX_MCP_URL!,         headers: { Authorization: `Bearer ${process.env.RX_TOKEN}` } },
    // Billing
    { name: 'billing',     url: process.env.BILLING_MCP_URL!,    headers: { Authorization: `Bearer ${process.env.BILLING_TOKEN}` } },
    // Insurance eligibility
    { name: 'eligibility', url: process.env.ELIG_MCP_URL!,       headers: { Authorization: `Bearer ${process.env.ELIG_TOKEN}` } },
  ],

  memory: {
    // Memory MUST be tied to verified patient ID, never phone alone
    service: new LibsqlMemoryService({ url: process.env.TURSO_URL!, authToken: process.env.TURSO_TOKEN! }),
    preload: { maxTokens: 400 },                  // prior appts, preferred provider, language
    ingest:  { auto: true, strategy: 'extract' },
  },

  compaction: { reserveTokens: 8000, keepRecentTokens: 4000 },

  observability: {
    sinks: [otelSink({ tracer })],                // every turn = one OTel span = audit row
  },
});

export default cedar;

// server.ts (separate file)
//
// import { Hono } from 'hono';
// import { webAdapter } from '@floe/adapter-web';
// import { elevenLabsAdapter } from '@floe/adapter-elevenlabs';
// import { cedar } from './assistant.ts';
// const app = new Hono();
// app.route('/', webAdapter({ assistant: cedar }));
// app.route('/voice', elevenLabsAdapter({ assistant: cedar, voiceId: 'calm-female-en' }));
// export default app;

export default floe;
```

## Where the runtime catches what the LLM mustn't

This is the part that earns the positioning. Three classes of decision
must NEVER touch the LLM:

### 1. Emergency keyword guard (preLLM validator, runtime-only)

```ts
// guards/emergency.ts — your code, ~30 LOC, deterministic
const EMERGENCY_PATTERNS = [
  /chest pain/i, /can't breathe/i, /cant breathe/i,
  /unconscious|passing out/i, /suicid/i, /heavy bleeding/i,
  /stroke|face droop/i, /overdose/i, /not responsive/i,
];

export function emergencyKeywordGuard({ phase, onMatch }) {
  return {
    name: 'emergency-guard',
    phase,
    async run({ turn }) {
      const text = turn.userMessage;
      if (EMERGENCY_PATTERNS.some(re => re.test(text))) {
        return {
          block: {
            reason: 'EMERGENCY_KEYWORD_MATCH',
            scriptedReply:
              "If this is a life-threatening emergency, please hang up and " +
              "call 911 immediately. I'm connecting you to our nurse line now.",
            triageOutcome: 'EMERGENCY',
          },
        };
      }
      return { ok: true };
    },
  };
}
```

When matched, the validator's `block` short-circuits the orchestrator
BEFORE the LLM is called. The scripted reply is sent verbatim. Handoff
policy sees `triageOutcome === 'EMERGENCY'` and routes to the stat
nurse queue. **Zero LLM cost, zero LLM judgment, deterministic
guarantee** for the highest-stakes case.

Yes, false positives happen (someone says "my chest hurts from
yesterday's workout"). Better safe — the nurse handles those triage
calls every day; that's literally their job.

### 2. Identity verification (channel-layer, not LLM)

The `resolveUserId` hook checks `metadata.verifiedPatientId`. The
CHANNEL is responsible for setting it:

- Web: SSO session cookie → backend verifies → injects patientId
- Voice: phone number + DOB challenge handled by the voice gateway flow
  BEFORE the conversation starts → injects patientId

If `verifiedPatientId` is missing, memory preload is skipped, MCP tools
that require patient context refuse to execute (the MCP server-side
enforces this — not the LLM's job), and the system prompt instructs the
bot to start with verification.

The LLM never reasons about "should I share this info" — the runtime
ensures the tools only return data the verified user is entitled to.

### 3. PII redaction (preLLM validator)

If a panicked patient pastes their SSN into the chat ("my SSN is
123-45-6789, please cancel my appointment"), the redaction validator
masks it to `[SSN]` BEFORE the LLM sees it. The LLM never has SSN in
its context window, so it can't echo it, log it, or accidentally
include it in a tool call.

## One turn end-to-end (the make-or-break case)

Caller: *"Hi, I'm having some chest pain and I'm not sure what to do."*

```
Voice gateway → POST /agents/voice/<call-sid>
  body: { type: 'user_text_sent',
          content: "I'm having some chest pain and I'm not sure what to do",
          metadata: { verifiedPatientId: 'pt_4421', phone: '+1-415-...', callSid: 'CA...' } }

──► prepareTurn
    • beginTurn(callSid, requestSignal)
    • init harness w/ MCP + sandbox
    • Load state (turn 1, new conversation)
    • Memory preload skipped (turn 1) — patient context fetched on demand
    • No triage (single host)

──► retrieve  (runs BEFORE validators, fast)
    • Knowledge lookup on "chest pain" → triage protocol chunk

──► respond — preLLM validator phase fires FIRST
    • emergencyKeywordGuard: /chest pain/i MATCHES
    • Returns { block: {
        reason: 'EMERGENCY_KEYWORD_MATCH',
        scriptedReply: "If this is a life-threatening emergency, please
          hang up and call 911 immediately. I'm connecting you to our
          nurse line now.",
        triageOutcome: 'EMERGENCY' } }
    • Orchestrator short-circuits — no LLM call

──► handoff policy fires
    • triageOutcome === 'EMERGENCY' → escalate
    • genesysInbox.send({
        queue: 'nurse-stat', priority: 10,
        prefixMessage: 'EMERGENCY — patient may need 911 advice',
        transcript: [<this one turn>],
        patient: { id: 'pt_4421', phone: '+1-415-...' },
        callSid: 'CA...',          // voice gateway uses this to bridge the call
      })

──► finalize
    • Persist state: lifecycle moved to 'escalated'
    • Transcript append (audit row)
    • TurnMetrics: validatorVerdict='block', interrupted=false,
      triageOutcome='EMERGENCY', tasks=0, llm=0ms, totalMs=180ms
    • Scripted reply streamed to TTS

Voice gateway:
    • Plays the scripted reply audio (~3 seconds)
    • Receives bridge instruction from Genesys
    • Conferences in the on-shift triage nurse via warm transfer
    • Nurse joins with full context already in their queue panel
```

**~180ms total. Zero LLM cost. Deterministic.** That's what the
runtime-vs-LLM split buys at the high-stakes end.

A NON-emergency turn (rescheduling) would run the full LLM loop, MCP
tool calls, sentence-by-sentence streaming, memory ingest at finalize —
exactly like the Hearth walkthrough.

## Runtime vs LLM, this scenario

| Decision | Who | Why |
|---|---|---|
| Is this an emergency keyword? | **Runtime** (regex + classifier) | Cannot risk LLM missing it |
| Is the patient identity verified? | **Runtime** (channel layer) | Compliance, not semantic |
| Did the patient paste a SSN? | **Runtime** (preLLM redaction validator) | LLM must never see it |
| Which queue routes the escalation? | **Runtime** (handoff config) | Deterministic per triageOutcome |
| Which channel modality? | **Runtime** (channel overlay) | Mechanical, not semantic |
| When does lifecycle move to 'idle' or 'escalated'? | **Runtime** (lifecycle config) | Time-based, not semantic |
| Should we abort if patient hangs up mid-reply? | **Runtime** (turn-registry + barge-in) | Both layers |
| What does the patient actually want? | **LLM** (intent in system prompt) | Semantic |
| Match symptom to triage tier (non-emergency)? | **LLM** + triage role + knowledge base | Semantic, with knowledge guardrails |
| Which available slot to suggest? | **LLM** + EHR tool | Semantic + tool |
| Which language to use for older patient? | **LLM** (with voice overlay hints) | Semantic |
| Did we successfully reschedule? | **Tool return** (deterministic) | Not asking the LLM to "trust me, I did it" |

The discipline: **runtime owns rules with binary outcomes; LLM owns
judgment with semantic outcomes.**

## Multi-channel continuity (the under-told story)

Patient calls Monday from the car about a refill issue → bot handles →
call ends.
Same patient opens portal widget Tuesday: "Did my refill go through?"

- Channel changes (voice → web)
- Same `verifiedPatientId` resolves (SSO)
- Same Turso-backed conversation? No — these are separate sessions
- **But memory bridges them**: Monday's `ingestTurn` recorded "Patient
  called about Rx refill for atorvastatin — pharmacy confirmed, ready
  Wednesday"
- Tuesday's `preload` injects that into Tuesday's system prompt
- Bot answers: "Yes — your atorvastatin refill is ready at CVS Mission,
  available tomorrow."

No special "session merging" logic. Memory keyed by `patientId` is the
bridge. The framework's contribution: making this trivially
configurable (`resolveUserId` + `memory.service`).

## What Floe stops at (compliance scoping)

| Layer | Bring your own | Why |
|---|---|---|
| HIPAA-eligible LLM provider (BAA with OpenAI/Anthropic/Azure) | Yes | Legal, not technical |
| BAA-covered infrastructure (Turso, hosting, observability) | Yes | Legal |
| Identity verification flow itself | Yes | Domain-specific UX |
| EHR integration (Epic via FHIR, Cerner) | MCP server | Domain expertise |
| Real triage protocols (often licensed from Schmitt/Thompson) | Knowledge content | Licensed IP |
| Medical advisory board oversight | Outside software | Governance |
| Audit log retention (7-year HIPAA min) | Sink config | You pick the sink |
| Speech engine BAA-coverage | Yes | Some engines aren't HIPAA-eligible |

Floe provides the *shape* — primitives that let you express the
policy. The actual policy content is yours.

## What this hospital walkthrough demonstrates that the meal-kit one didn't

| Pattern | Demonstrated by |
|---|---|
| **Runtime-only safety guard short-circuits the LLM** | emergencyKeywordGuard at preLLM phase, $0 LLM cost, deterministic |
| **Identity tied to channel, not conversation** | resolveUserId reading channel-provided verifiedPatientId |
| **Pre-LLM PII redaction** | piiRedaction validator masks SSN before LLM sees it |
| **Differentiated escalation routing per outcome** | handoff config maps triageOutcome to four different queues |
| **Cross-channel memory bridging** | Voice Monday → web Tuesday, same patientId surfaces context |
| **Per-turn audit row (OTel sink)** | TurnMetrics + otelSink = one span per turn, ready for retention |
| **Stakes-aware channel overlays** | Voice: short sentences, slow, "one question at a time" for distressed callers |

The framing earns its keep here. A pure-chat framework (AI SDK,
LangChain) doesn't have:

- A preLLM validator phase that can scripted-reply + escalate
- A channel-aware lifecycle state machine
- A handoff port with per-outcome routing
- A memory bridge across channel-switching

A pure-agent framework (Flue alone, OpenAI Agents SDK) doesn't have:

- Channels as a primitive
- The conversation lifecycle
- The handoff/inbox pattern
- The validator phases (preLLM/postLLM/postLLM-async)

Agentic conversation is exactly this intersection. Hospital is the use
case where every cell of the runtime-vs-LLM table earns its existence.

## What to build to prove this works

`examples/cedar-health/` with:

1. The config above (after the v1 BLUEPRINT migration → roles, not Agents)
2. A stub `emergencyKeywordGuard` (~30 LOC) — the user-written piece
3. Stub EHR / Rx / Billing MCP servers (in-memory state, like
   `mcp-bot`)
4. A small React widget calling `floe.fetch` (web channel)
5. A glue script connecting Cartesia/ElevenLabs Conversational AI →
   `floe.fetch` (voice channel)
6. Live tests:
   - The emergency scripted-reply path fires within 200ms with zero LLM
     call
   - Cross-channel memory bridge (voice turn → web turn surfaces
     context)
   - Validator + handoff drop a real ticket into a mock Genesys inbox
