# @floe/adapter-voice

Voice channel adapter for Floe Assistants. Generic speech-engine
entrypoint (ElevenLabs Conversational AI, Vapi, Cartesia, Pipecat,
OpenAI Realtime) + a Twilio Voice webhook helper for direct PSTN
integration.

Floe is **brain-only** — STT/TTS/barge-in is the speech engine's job.
This adapter is the brain-to-engine boundary: takes a transcript-in,
returns sentence-shaped SSE chunks the engine pipes to TTS.

## Generic speech-engine entrypoint

```ts
import { runServer } from '@floe/server-bootstrap';
import { voiceAdapter } from '@floe/adapter-voice';
import { hearth } from './assistant.ts';

await runServer(hearth, {
  routes: { '/voice/turn': voiceAdapter({
    assistant: hearth,
    resolveUserId: (m) => (m?.subscriberId as string | undefined),
  }) },
});
```

**Inbound** (your speech engine POSTs after its own STT + end-of-turn
detection):

```json
POST /voice/turn
{
  "sessionId": "call-CA1234...",
  "transcript": "Hey can you skip next week for me?",
  "metadata": { "subscriberId": "sub_8821", "phone": "+1-415-555-..." }
}
```

**Outbound** (SSE stream of sentence chunks, ready for TTS):

```
event: sentence
data: {"text":"Got it — pausing your May 30 delivery."}

event: sentence
data: {"text":"That saves you $84."}

event: done
data: {"runId":"r-42","content":"Got it — pausing your May 30 delivery. That saves you $84."}
```

The adapter automatically sets a voice overlay (`sequentialToolUse: true`,
`maxResponseTokens: 100`) so the LLM produces tighter, sequentially-acted
replies appropriate for voice.

## Twilio direct (cheapest path, basic TTS)

```ts
import { twilioVoiceWebhook } from '@floe/adapter-voice/twilio';

await runServer(hearth, {
  routes: { '/twilio/voice': twilioVoiceWebhook({
    assistant: hearth,
    actionUrl: 'https://my-host.example/twilio/voice',
    voice: 'Polly.Joanna',
    greeting: "Hi! How can I help today?",
  }) },
});
```

Configure your Twilio number's voice webhook to POST to that URL. Each
turn: Twilio captures speech with `<Gather>`, POSTs the `SpeechResult`,
the adapter drives `Assistant.run`, and TwiML `<Say>` plays the reply
before re-opening another `<Gather>` for the next turn.

## When to use each

| Want | Use |
|---|---|
| ElevenLabs / Vapi / Cartesia / OpenAI Realtime (best quality, barge-in) | `voiceAdapter` |
| Twilio PSTN, basic TTS, minimal setup | `twilioVoiceWebhook` |
| Custom speech engine with sentence-streaming TTS | `voiceAdapter` — implements a generic protocol |

## What this hides

- Sentence-boundary detection (TTS engines hate mid-sentence chunks)
- Voice overlay setup (sequential tools + short responses)
- `X-Floe-Channel: voice` header injection
- The SSE wire format your speech engine plugs into

## What you bring

- A speech engine of your choice (one of the above)
- Phone-number identity verification (DOB challenge etc) — the adapter
  trusts `metadata.verifiedPatientId` (or whatever your `resolveUserId`
  extracts) as already-verified at the gateway layer.
