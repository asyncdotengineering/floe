/**
 * Ops-bot server. Mounts:
 *   - the web channel on `/agents/web/<sessionId>` (Floe-aware UIs +
 *     OpenAI-SDK clients via openai-compat)
 *   - the Slack channel on `/slack/events` when SLACK_SIGNING_SECRET +
 *     SLACK_BOT_TOKEN are present
 *
 * The 3 mock MCP servers (Okta + Notion + Linear) come up via
 * `beforeListen` so they're ready before the Assistant boots, and
 * shut down cleanly when the process exits.
 */
import { runServer } from '@floe/server-bootstrap';
import { slackAdapter } from '@floe/adapter-slack';
import { createOpsBot } from './floe.config.ts';

const { assistant, mocks } = await createOpsBot();

const routes: Record<string, (req: Request) => Promise<Response>> = {};
if (process.env.SLACK_SIGNING_SECRET && process.env.SLACK_BOT_TOKEN) {
	routes['/slack/events'] = slackAdapter({
		assistant,
		signingSecret: process.env.SLACK_SIGNING_SECRET,
		botToken: process.env.SLACK_BOT_TOKEN,
	});
	console.log('[ops-bot] Slack adapter mounted at /slack/events');
} else {
	console.log(
		'[ops-bot] Slack adapter SKIPPED — set SLACK_SIGNING_SECRET + SLACK_BOT_TOKEN to enable.',
	);
}

await runServer(assistant, {
	openaiCompat: true,
	routes,
	beforeListen: async () => {
		// Mocks are already up (we mounted them in createOpsBot).
		// Return the shutdown closure so the runServer teardown stops them.
		return async () => {
			await mocks.stopAll();
		};
	},
});
