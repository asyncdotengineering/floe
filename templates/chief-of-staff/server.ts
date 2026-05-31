/**
 * Chief-of-staff server. Mounts web + optional Slack (for DM-based
 * "brief me on…" / "what's overdue" / "draft me a quick reply" use).
 */
import { runServer } from '@floe/server-bootstrap';
import { slackAdapter } from '@floe/adapter-slack';
import { createChiefOfStaff } from './floe.config.ts';

const { assistant, mocks, jobs } = await createChiefOfStaff();

const routes: Record<string, (req: Request) => Promise<Response>> = {};
if (process.env.SLACK_SIGNING_SECRET && process.env.SLACK_BOT_TOKEN) {
	routes['/slack/events'] = slackAdapter({
		assistant,
		signingSecret: process.env.SLACK_SIGNING_SECRET,
		botToken: process.env.SLACK_BOT_TOKEN,
		sessionScope: 'channel',
	});
	console.log('[chief-of-staff] Slack adapter mounted at /slack/events');
} else {
	console.log(
		'[chief-of-staff] Slack adapter SKIPPED — set SLACK_SIGNING_SECRET + SLACK_BOT_TOKEN to enable.',
	);
}

await runServer(assistant, {
	openaiCompat: true,
	routes,
	beforeListen: async () => async () => {
		await jobs.stop();
		await mocks.stopAll();
	},
});
