/**
 * Hearth-bot server. Mounts:
 *   - the web channel on `/agents/web/<sessionId>` (chat UIs + OpenAI SDK)
 *   - the generic voice channel on `/voice/turn` (any speech engine)
 *   - the Twilio direct webhook on `/twilio/voice` (only when
 *     TWILIO_VOICE_WEBHOOK_URL is set — the URL must be the public
 *     URL of THIS endpoint so Twilio can loop back to it for each turn)
 */
import { runServer } from '@floe/server-bootstrap';
import { voiceAdapter, twilioVoiceWebhook } from '@floe/adapter-voice';
import { createHearthBot } from './floe.config.ts';

const { assistant, mocks } = await createHearthBot();

const routes: Record<string, (req: Request) => Promise<Response>> = {
	'/voice/turn': voiceAdapter({
		assistant,
		resolveUserId: (m) =>
			(m?.subscriberId as string | undefined) ?? (m?.phone as string | undefined),
	}),
};
if (process.env.TWILIO_VOICE_WEBHOOK_URL) {
	routes['/twilio/voice'] = twilioVoiceWebhook({
		assistant,
		actionUrl: process.env.TWILIO_VOICE_WEBHOOK_URL,
		greeting:
			"Hi, thanks for calling Hearth. How can I help you today?",
	});
	console.log('[hearth-bot] Twilio webhook mounted at /twilio/voice');
}

await runServer(assistant, {
	openaiCompat: true,
	routes,
	beforeListen: async () => {
		return async () => {
			await mocks.stopAll();
		};
	},
});
