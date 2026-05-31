/**
 * @floe/adapter-slack — Slack channel adapter for Floe Assistants.
 *
 * Mounts an Events API webhook endpoint that:
 *   1. Verifies Slack's HMAC-SHA256 signature on every request.
 *   2. Handles Slack's `url_verification` handshake.
 *   3. Routes DMs + `app_mention` events into Floe conversations,
 *      using `<teamId>:<channel>[:<thread>]` as the stable sessionId.
 *   4. Drives `assistant.run({...})` programmatically and posts the
 *      assistant's reply to the Slack channel via the Web API.
 *
 * Slack acks the webhook within 3s (Slack's hard requirement) — we
 * return 200 IMMEDIATELY and process the turn asynchronously.
 *
 * Usage:
 *
 *   import { slackAdapter } from '@floe/adapter-slack';
 *   import { ops } from './assistant.ts';
 *
 *   await runServer(ops, {
 *     routes: {
 *       '/slack/events': slackAdapter({
 *         assistant: ops,
 *         signingSecret: process.env.SLACK_SIGNING_SECRET!,
 *         botToken: process.env.SLACK_BOT_TOKEN!,
 *       }),
 *     },
 *   });
 *
 * Slack app config (in api.slack.com/apps):
 *   - Event Subscriptions → Request URL: https://your.host/slack/events
 *   - Subscribe to bot events: app_mention, message.im
 *   - Bot Token Scopes: app_mentions:read, chat:write, im:history, im:read
 */
import type { Assistant } from '@floe/runtime';
import { verifySlackSignature } from './signature.ts';
import { createSlackClient, type SlackClient } from './client.ts';

export interface SlackAdapterOptions {
	assistant: Assistant;
	signingSecret: string;
	botToken: string;
	/**
	 * Optional thread strategy. Default `'channel'` (one session per
	 * channel — every message threads into the same conversation).
	 * `'thread'` opens a fresh session per Slack thread root.
	 */
	sessionScope?: 'channel' | 'thread';
	/** Override the Slack client (testing). */
	clientOverride?: SlackClient;
	/** Override the signature check clock (testing). */
	now?: () => number;
}

export type SlackAdapterHandler = (req: Request) => Promise<Response>;

interface SlackEventEnvelope {
	type: string;
	token?: string;
	challenge?: string;
	team_id?: string;
	event?: SlackEvent;
}

interface SlackEvent {
	type: string;
	user?: string;
	text?: string;
	channel?: string;
	ts?: string;
	thread_ts?: string;
	bot_id?: string;
	subtype?: string;
}

export function slackAdapter(opts: SlackAdapterOptions): SlackAdapterHandler {
	const client =
		opts.clientOverride ?? createSlackClient({ botToken: opts.botToken });
	const scope = opts.sessionScope ?? 'channel';

	return async function handleSlack(req: Request): Promise<Response> {
		if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

		const rawBody = await req.text();
		const verify = verifySlackSignature(req.headers, rawBody, {
			signingSecret: opts.signingSecret,
			...(opts.now ? { now: opts.now } : {}),
		});
		if (!verify.ok) {
			return new Response(
				JSON.stringify({ error: 'signature_invalid', reason: verify.reason }),
				{ status: 401, headers: { 'content-type': 'application/json' } },
			);
		}

		let envelope: SlackEventEnvelope;
		try {
			envelope = JSON.parse(rawBody) as SlackEventEnvelope;
		} catch {
			return new Response('bad json', { status: 400 });
		}

		// URL verification handshake — Slack requires the literal challenge string back.
		if (envelope.type === 'url_verification' && envelope.challenge) {
			return new Response(envelope.challenge, {
				status: 200,
				headers: { 'content-type': 'text/plain' },
			});
		}

		if (envelope.type !== 'event_callback' || !envelope.event) {
			return new Response('ok', { status: 200 });
		}

		const ev = envelope.event;
		// Drop bot-authored messages (no echo loops) + message subtypes
		// other than the plain user message (edits, joins, etc).
		if (ev.bot_id) return new Response('ok', { status: 200 });
		if (
			ev.type !== 'app_mention' &&
			!(ev.type === 'message' && (!ev.subtype || ev.subtype === undefined))
		) {
			return new Response('ok', { status: 200 });
		}
		if (!ev.text || !ev.channel || !ev.user) {
			return new Response('ok', { status: 200 });
		}

		const text = stripMentions(ev.text);
		const sessionId = buildSessionId({
			scope,
			teamId: envelope.team_id ?? 'unknown-team',
			channel: ev.channel,
			thread: ev.thread_ts ?? ev.ts,
		});
		const threadTs = ev.thread_ts ?? ev.ts;

		// Fire-and-forget the turn — Slack requires a 200 within 3s.
		void (async () => {
			try {
				const result = await opts.assistant.run(text, {
					sessionId,
					userId: ev.user,
					metadata: {
						slackUserId: ev.user,
						slackChannel: ev.channel,
						slackTeamId: envelope.team_id,
						slackThreadTs: threadTs,
					},
				});
				const reply = result.content?.trim();
				if (reply) {
					await client.postMessage({
						channel: ev.channel!,
						text: reply,
						...(threadTs ? { threadTs } : {}),
					});
				}
			} catch (err) {
				console.error('[adapter-slack] turn failed:', err);
				try {
					await client.postMessage({
						channel: ev.channel!,
						text: ':warning: I hit an error processing that — please try again.',
						...(threadTs ? { threadTs } : {}),
					});
				} catch {
					// already in the failure path — give up.
				}
			}
		})();

		return new Response('ok', { status: 200 });
	};
}

function stripMentions(text: string): string {
	// Slack mentions look like `<@U07ABC>` — strip them out of the body
	// before handing to the LLM. The mention metadata is already in
	// `ev.user`; the LLM doesn't need to see the raw tag.
	return text.replace(/<@[UW][A-Z0-9]+>/g, '').replace(/\s+/g, ' ').trim();
}

interface BuildSessionIdArgs {
	scope: 'channel' | 'thread';
	teamId: string;
	channel: string;
	thread: string | undefined;
}

function buildSessionId(args: BuildSessionIdArgs): string {
	if (args.scope === 'thread' && args.thread) {
		return `${args.teamId}:${args.channel}:${args.thread}`;
	}
	return `${args.teamId}:${args.channel}`;
}

export { verifySlackSignature } from './signature.ts';
export { createSlackClient } from './client.ts';
export type { SlackClient, SlackPostMessageArgs, SlackPostMessageResult } from './client.ts';
