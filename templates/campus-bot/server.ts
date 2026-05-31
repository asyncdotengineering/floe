/**
 * Campus-bot server. Mounts:
 *   - the web channel on `/agents/web/<sessionId>` (chat UIs + OpenAI SDK)
 *   - the generic voice channel on `/voice/turn` (any speech engine)
 *   - the Twilio direct webhook on `/twilio/voice` (only when
 *     TWILIO_VOICE_WEBHOOK_URL is set)
 */
import { runServer } from '@floe/server-bootstrap';
import { voiceAdapter, twilioVoiceWebhook } from '@floe/adapter-voice';
import { createCampusBot } from './floe.config.ts';

const { assistant } = await createCampusBot();

const routes: Record<string, (req: Request) => Promise<Response>> = {
	'/voice/turn': voiceAdapter({
		assistant,
		resolveUserId: (m) =>
			(m?.studentId as string | undefined) ?? (m?.email as string | undefined),
	}),
};
if (process.env.TWILIO_VOICE_WEBHOOK_URL) {
	routes['/twilio/voice'] = twilioVoiceWebhook({
		assistant,
		actionUrl: process.env.TWILIO_VOICE_WEBHOOK_URL,
		greeting:
			"Hi, you've reached the student help line. How can I help you today?",
	});
	console.log('[campus-bot] Twilio webhook mounted at /twilio/voice');
}

await runServer(assistant, {
	openaiCompat: true,
	routes,
});
