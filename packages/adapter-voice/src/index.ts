/**
 * @floe/adapter-voice — voice channel adapter for Floe Assistants.
 *
 * Generic speech-engine entrypoint: ElevenLabs Conversational AI, Vapi,
 * Cartesia, Pipecat, OpenAI Realtime, etc. all POST a finalized user
 * turn (after their own STT + end-of-turn detection) and consume an
 * SSE stream of sentence-shaped chunks that they pipe straight to TTS.
 *
 * Floe is **brain-only** — STT/TTS/barge-in is the speech engine's
 * job. This adapter is the brain-to-engine boundary: takes a
 * transcript-in, returns sentence-out.
 *
 * Wire format:
 *   - Inbound:  POST /voice/turn  (JSON: { sessionId, transcript, metadata? })
 *   - Outbound: text/event-stream — one `event: sentence` SSE event per
 *               flushed sentence, plus a final `event: done` carrying
 *               { content, runId } for the engine to log.
 *
 * Usage:
 *
 *   import { voiceAdapter } from '@floe/adapter-voice';
 *   import { hearth } from './assistant.ts';
 *
 *   await runServer(hearth, {
 *     routes: { '/voice/turn': voiceAdapter({ assistant: hearth }) },
 *   });
 */
import type { Assistant } from '@floe/runtime';
import { SentenceStreamer } from './sentence-stream.ts';

export interface VoiceAdapterOptions {
	assistant: Assistant;
	/**
	 * Pull the verified user id from the inbound metadata. The voice
	 * gateway is responsible for doing the actual verification (DOB +
	 * phone challenge etc); this hook just maps its output into Floe's
	 * userId for memory-keying.
	 */
	resolveUserId?: (metadata: Record<string, unknown> | undefined) => string | undefined;
	/**
	 * Channel-overlay hints surfaced via the `X-Floe-Channel: voice`
	 * header on the underlying turn. Voice mode forces sequential tool
	 * use + shorter replies via the channel overlay; this hook lets
	 * you pre-set fields via metadata if your speech engine is unusual.
	 */
}

export type VoiceAdapterHandler = (req: Request) => Promise<Response>;

interface VoiceTurnRequest {
	sessionId?: string;
	transcript?: string;
	metadata?: Record<string, unknown>;
}

export function voiceAdapter(opts: VoiceAdapterOptions): VoiceAdapterHandler {
	const resolveUserId = opts.resolveUserId ?? ((m) => m?.userId as string | undefined);

	return async function handleVoice(req: Request): Promise<Response> {
		if (req.method !== 'POST') {
			return new Response('method not allowed', { status: 405 });
		}
		let body: VoiceTurnRequest;
		try {
			body = (await req.json()) as VoiceTurnRequest;
		} catch {
			return new Response('bad json', { status: 400 });
		}
		if (!body.sessionId || typeof body.sessionId !== 'string') {
			return jsonError('sessionId required', 400);
		}
		if (!body.transcript || typeof body.transcript !== 'string') {
			return jsonError('transcript required', 400);
		}

		const userId = resolveUserId(body.metadata);

		const turn = opts.assistant.run(body.transcript, {
			sessionId: body.sessionId,
			...(userId ? { userId } : {}),
			metadata: { ...(body.metadata ?? {}), channel: 'voice' },
			overlay: { sequentialToolUse: true, maxResponseTokens: 100 },
		});

		const stream = buildSentenceSseStream(turn);
		return new Response(stream, {
			status: 200,
			headers: {
				'content-type': 'text/event-stream',
				'cache-control': 'no-cache, no-transform',
				connection: 'keep-alive',
				'x-floe-channel': 'voice',
			},
		});
	};
}

function buildSentenceSseStream(
	turn: import('@floe/runtime').TurnHandle,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const streamer = new SentenceStreamer();

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (event: string, data: unknown) => {
				controller.enqueue(
					encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
				);
			};
			try {
				for await (const ev of turn.events) {
					if (ev.type === 'agent_send_partial' && typeof ev.delta === 'string') {
						for (const flushed of streamer.push(ev.delta)) {
							send('sentence', { text: flushed.sentence, finalRemainder: false });
						}
					}
				}
				for (const flushed of streamer.flush()) {
					send('sentence', { text: flushed.sentence, finalRemainder: true });
				}
				const output = await turn;
				send('done', { runId: output.runId, content: output.content });
				controller.close();
			} catch (err) {
				send('error', { message: err instanceof Error ? err.message : String(err) });
				controller.close();
			}
		},
		cancel() {
			turn.cancel('voice-client-disconnect');
		},
	});
}

function jsonError(message: string, status: number): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

export { SentenceStreamer } from './sentence-stream.ts';
export type { SentenceFlush } from './sentence-stream.ts';
export { twilioVoiceWebhook } from './twilio.ts';
export type { TwilioVoiceOptions } from './twilio.ts';
