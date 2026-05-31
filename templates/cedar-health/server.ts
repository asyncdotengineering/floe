/**
 * Cedar Health server. Mounts web channel + voice channel + Twilio
 * direct (only when configured).
 */
import { runServer } from '@floe/server-bootstrap';
import { voiceAdapter, twilioVoiceWebhook } from '@floe/adapter-voice';
import { createCedarHealth } from './floe.config.ts';

const { assistant, mocks } = await createCedarHealth();

const routes: Record<string, (req: Request) => Promise<Response>> = {
	'/voice/turn': voiceAdapter({
		assistant,
		resolveUserId: (m) => m?.verifiedPatientId as string | undefined,
	}),
};
if (process.env.TWILIO_VOICE_WEBHOOK_URL) {
	routes['/twilio/voice'] = twilioVoiceWebhook({
		assistant,
		actionUrl: process.env.TWILIO_VOICE_WEBHOOK_URL,
		greeting:
			"Thanks for calling Cedar Health. For a life-threatening emergency, please hang up and call 911. Otherwise, how can I help you today?",
	});
}

await runServer(assistant, {
	openaiCompat: true,
	routes,
	beforeListen: async () => async () => mocks.stopAll(),
});
