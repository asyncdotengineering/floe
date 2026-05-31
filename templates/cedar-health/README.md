# Cedar Health — clinic patient assistant template

Clone-and-go Floe template for a **B2C high-stakes clinic assistant** —
voice (phone) + web (patient portal). Real downstream actions per turn:
EHR scheduling, Rx refills, billing. Three escalation lanes: routine
human scheduler, triage nurse line, and **911 instructions caught by
the runtime, not the LLM**.

This is the runnable build of [`docs/use-cases/03-b2c-clinic-bot.md`](../../docs/use-cases/03-b2c-clinic-bot.md).

> ⚠️ **Scoping caveat**: this is a framework walkthrough, not a
> deployable medical bot. Real medical AI needs medical advisory board
> oversight, BAA-covered infrastructure (LLM provider, hosting,
> observability), FDA navigation, malpractice considerations. Floe
> shows the SHAPE; the regulatory scaffolding is yours.

## What you get out of the box

- ✅ One **Floe Assistant** in `coordinate` mode with 3 specialist roles
  (`scheduler`, `triage-router`, `billing`)
- ✅ Three **mock MCP servers** (Patient FHIR-lite, Rx, Billing)
  running in-process
- ✅ **Runtime emergency keyword guard** — the make-or-break — that
  short-circuits the LLM with a scripted 911 reply for any
  life-threatening keyword. Zero LLM cost. Deterministic. Demonstrated
  by 13 positive-match tests + 5 negative-match tests.
- ✅ **PII redaction** validator masks SSN / credit card in user input
  before the LLM sees it
- ✅ **Identity-required guard** that nudges the LLM to verify before
  touching patient-specific tools
- ✅ **Voice adapter** + Twilio direct path
- ✅ **Web channel** + OpenAI-compat routes
- ✅ Cross-session memory keyed strictly by `verifiedPatientId`
- ✅ Knowledge base: triage protocols + scheduling/refills/billing policy

## Quick start

```sh
pnpm install
cp templates/cedar-health/.env.example templates/cedar-health/.env
# Set OPENAI_API_KEY (or your provider key) in .env

pnpm --filter cedar-health dev
```

You'll see:

```
[cedar-health:mocks] patient_fhir → http://localhost:4201/mcp
[cedar-health:mocks] rx           → http://localhost:4202/mcp
[cedar-health:mocks] billing      → http://localhost:4203/mcp
[cedar-health] listening on http://localhost:3130
```

### Test the make-or-break path (no LLM call)

The runtime emergency guard fires in `preLLM` — **the LLM is never
invoked** for these inputs:

```sh
curl -N -X POST http://localhost:3130/agents/web/sess-emergency \
  -H 'content-type: application/json' \
  -d '{"message":"Im having some chest pain and I dont know what to do"}'
```

You'll get a `[Escalating to 911: …]` response in under 200ms with zero
LLM token spend.

### Test a routine scheduling flow

```sh
curl -N -X POST http://localhost:3130/agents/web/sess-sched \
  -H 'content-type: application/json' \
  -d '{"message":"I need to reschedule my appointment with Dr. Chen. My MRN is MRN-100231 and my DOB is 1981-04-12","metadata":{"verifiedPatientId":"p_chen_amy"}}'
```

The assistant verifies identity (mock), looks up the appointment, and
proposes a reschedule slot.

### Voice channel

The voice adapter is mounted at `/voice/turn`. Any speech engine that
does its own STT + end-of-turn detection (ElevenLabs Conversational AI,
Vapi, Cartesia, Pipecat, OpenAI Realtime) can POST a finalized user
turn and consume the sentence-shaped SSE response.

## The runtime-vs-LLM table

This template demonstrates every cell of the runtime-vs-LLM discipline:

| Decision | Who | Where in this template |
|---|---|---|
| Is this an emergency? | **Runtime** | `guards/emergency.ts` (preLLM validator) |
| Is the patient identity verified? | **Runtime** | `guards/identity-required.ts` + `resolveUserId` |
| Did the patient paste a SSN? | **Runtime** | `piiRedaction` validator |
| Which queue routes an escalation? | **Runtime** | `escalate({ to: '911' })` (handoff layer extends this) |
| Which channel modality? | **Runtime** | `voiceAdapter` overlay (auto-sets sequential tools + short replies) |
| What does the patient want? | **LLM** | `systemPrompt` |
| Triage tier (non-emergency)? | **LLM** + role | `triage-router` role + `knowledge/triage-protocols.md` |
| Which appointment slot? | **LLM** + tool | `mcp__patient_fhir__schedule_appointment` |
| Did we successfully book? | **Tool return** | The MCP server's response — never "trust me, I did it" |

## Swapping mocks for real systems

When you're ready to swap in real EHR / Rx / Billing:

1. The mock services in `mocks.ts` are FHIR-LITE, not full FHIR R4.
   Production needs a real HAPI FHIR or vendor (Epic/Cerner) client.
2. The mock Rx service ignores schedule-2-5 controls entirely;
   production must enforce DEA + state-specific restrictions.
3. The mock Billing service is a flat-row store; production needs
   real claims/EOB/ERA integration.
4. Replace the corresponding `mountXxx` call and update the `mcp:[…]`
   entry to point at your real MCP server URL.

## Project layout

```
templates/cedar-health/
├── floe.config.ts                       — Assistant + roles + validators + mocks
├── server.ts                            — HTTP (web + voice + Twilio)
├── mocks.ts                             — Mock MCP lifecycle
├── guards/
│   ├── emergency.ts                     — preLLM 911 short-circuit
│   └── identity-required.ts             — soft verification nudge
├── knowledge/
│   ├── triage-protocols.md
│   ├── scheduling-policy.md
│   ├── refills-policy.md
│   └── billing-policy.md
├── AGENTS.md                            — Auto-loaded into system prompt
├── test/
│   ├── emergency-guard.test.ts          — The make-or-break test (no Assistant boot)
│   └── smoke.test.ts                    — Boot wiring + validator order
├── .env.example
├── package.json
├── tsconfig.json
└── README.md (you are here)
```

## Limitations you should know about

1. **Escalation surface text is `[Escalating to 911: <reason>]`** — the
   Floe runtime formats validator-escalate responses with bracket
   prefixes. The full scripted reply IS delivered over both wires (the
   SSE mux back-fills it when no LLM streamed; see live-API test
   below). For a polished UX, post-process the assistant text on the
   wire — strip the `[Escalating to <to>: ` prefix + trailing `]` in
   your voice TTS shim.
2. **Mocks don't enforce identity-verification gates** — the mock MCP
   tools execute even without a `verifiedPatientId`. In production, the
   MCP server MUST refuse to act on patient-specific operations without
   a verified id. The `identity-required` validator nudges the LLM but
   isn't a hard control.
3. **No phone-OTP step** — a real clinic bot needs a second-factor
   verification before discussing PHI. Out of scope for this template.

## Tests

```sh
pnpm --filter cedar-health test
```

Two test files: `emergency-guard.test.ts` (18 tests pinning the
make-or-break path — the most important test in this template) and
`smoke.test.ts` (boot wiring + validator ordering).
