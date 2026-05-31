/**
 * Twilio Voice webhook helper.
 *
 * Twilio POSTs `application/x-www-form-urlencoded` for `<Gather>` results
 * with `SpeechResult` containing the transcript. We reply with TwiML
 * that speaks the assistant's reply (via Twilio's `<Say>`) and then
 * re-opens a `<Gather>` for the next user turn.
 *
 * This is a thin compatibility shim — production deployments typically
 * use a richer speech engine (ElevenLabs/Cartesia/Vapi) via the
 * generic `voiceAdapter` instead. Twilio direct is the cheapest path
 * but the TTS quality is basic.
 */
import type { Assistant } from '@floe/runtime';

export interface TwilioVoiceOptions {
	assistant: Assistant;
	/**
	 * Public URL of THIS endpoint (Twilio re-invokes it for each turn).
	 * Twilio needs to know where to POST the next `<Gather>` result.
	 */
	actionUrl: string;
	/** Voice name for `<Say>`. Default `Polly.Joanna`. */
	voice?: string;
	/** Language code. Default `en-US`. */
	language?: string;
	/** Greeting played on first invocation when there's no SpeechResult yet. */
	greeting?: string;
}

export type TwilioHandler = (req: Request) => Promise<Response>;

export function twilioVoiceWebhook(opts: TwilioVoiceOptions): TwilioHandler {
	const voice = opts.voice ?? 'Polly.Joanna';
	const lang = opts.language ?? 'en-US';
	const greeting = opts.greeting ?? "Hi, you've reached the assistant. How can I help?";

	return async function handleTwilio(req: Request): Promise<Response> {
		if (req.method !== 'POST') {
			return new Response('method not allowed', { status: 405 });
		}
		const form = await req.formData();
		const callSid = String(form.get('CallSid') ?? '');
		const from = String(form.get('From') ?? '');
		const transcript = String(form.get('SpeechResult') ?? '').trim();

		if (!callSid) {
			return twiml(speak("I'm sorry, I didn't catch that call setup. Please try again.", { voice, lang }));
		}

		// First call (no SpeechResult yet) → greet + gather.
		if (!transcript) {
			return twiml(
				`${speak(greeting, { voice, lang })}\n${gather(opts.actionUrl, { lang })}`,
			);
		}

		// Drive the turn.
		let replyText: string;
		try {
			const output = await opts.assistant.run(transcript, {
				sessionId: `twilio:${callSid}`,
				userId: from,
				metadata: { channel: 'voice', provider: 'twilio', callSid, from },
				overlay: { sequentialToolUse: true, maxResponseTokens: 100 },
			});
			replyText = (output.content ?? '').trim() ||
				"I'm sorry, I didn't have a response for that. Could you try rephrasing?";
		} catch (err) {
			console.error('[adapter-voice:twilio] turn failed:', err);
			replyText = "I hit an error processing that. Please try again.";
		}

		return twiml(
			`${speak(replyText, { voice, lang })}\n${gather(opts.actionUrl, { lang })}`,
		);
	};
}

function twiml(inner: string): Response {
	const body = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${inner}\n</Response>`;
	return new Response(body, {
		status: 200,
		headers: { 'content-type': 'application/xml; charset=utf-8' },
	});
}

function speak(text: string, { voice, lang }: { voice: string; lang: string }): string {
	return `<Say voice="${voice}" language="${lang}">${escapeXml(text)}</Say>`;
}

function gather(actionUrl: string, { lang }: { lang: string }): string {
	return `<Gather input="speech" speechTimeout="auto" language="${lang}" action="${escapeXml(actionUrl)}" method="POST"/>`;
}

function escapeXml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}
