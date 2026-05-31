/**
 * Knowledge-worker server. Mounts:
 *   - the web channel on `/agents/web/<sessionId>` (chat UI + OpenAI SDK)
 *   - the Slack channel on `/slack/events` when SLACK_SIGNING_SECRET +
 *     SLACK_BOT_TOKEN are present (useful for quick DM lookups while
 *     you're in flow elsewhere)
 *
 * The 4 mock MCP servers (Notion + Linear + Calendar + Email) come up
 * via `beforeListen` and shut down cleanly on signal.
 */
import { runServer } from '@floe/server-bootstrap';
import { slackAdapter } from '@floe/adapter-slack';
import { createKnowledgeWorker } from './floe.config.ts';

const { assistant, mocks } = await createKnowledgeWorker();

const routes: Record<string, (req: Request) => Promise<Response>> = {};
if (process.env.SLACK_SIGNING_SECRET && process.env.SLACK_BOT_TOKEN) {
	routes['/slack/events'] = slackAdapter({
		assistant,
		signingSecret: process.env.SLACK_SIGNING_SECRET,
		botToken: process.env.SLACK_BOT_TOKEN,
		sessionScope: 'channel',
	});
	console.log('[knowledge-worker] Slack adapter mounted at /slack/events');
} else {
	console.log(
		'[knowledge-worker] Slack adapter SKIPPED — set SLACK_SIGNING_SECRET + SLACK_BOT_TOKEN to enable.',
	);
}

await runServer(assistant, {
	openaiCompat: true,
	routes,
	beforeListen: async () => async () => mocks.stopAll(),
});
