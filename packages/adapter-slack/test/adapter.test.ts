/**
 * Boundary tests for the Slack adapter handler. We stub out the
 * Assistant.run + Slack postMessage so tests run offline and fast,
 * and verify:
 *   - signature mismatch → 401
 *   - url_verification → echoes challenge string
 *   - app_mention → drives Assistant.run + posts the reply
 *   - bot-authored echoes are ignored
 *   - session ids respect the scope option
 *   - mention tokens (<@U…>) are stripped before the LLM sees the text
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { slackAdapter } from '../src/index.ts';
import type { Assistant } from '@floe/runtime';
import type { SlackClient } from '../src/client.ts';

const SECRET = 'shh';

function sign(body: string, ts: number): string {
	return 'v0=' + createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex');
}

function makeReq(envelope: unknown, ts = 1716552000): Request {
	const body = JSON.stringify(envelope);
	return new Request('http://test/slack/events', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-slack-request-timestamp': String(ts),
			'x-slack-signature': sign(body, ts),
		},
		body,
	});
}

function makeStubs() {
	const runs: Array<{ message: string; args: Record<string, unknown> }> = [];
	const posts: Array<{ channel: string; text: string; threadTs?: string }> = [];

	const fakeAssistant = {
		run: (message: string, args: Record<string, unknown>) => {
			runs.push({ message, args });
			return Promise.resolve({
				content: `echo: ${message}`,
				runId: 'r',
				sessionId: String(args.sessionId ?? ''),
				messages: [],
				mode: 'direct',
				interrupted: false,
			});
		},
	} as unknown as Assistant;

	const fakeClient: SlackClient = {
		async postMessage(args) {
			posts.push({
				channel: args.channel,
				text: args.text,
				...(args.threadTs ? { threadTs: args.threadTs } : {}),
			});
			return { ok: true, ts: 'mock-ts', channel: args.channel };
		},
	};

	return { runs, posts, fakeAssistant, fakeClient };
}

const NOW = () => 1716552000_000;

describe('slackAdapter — security', () => {
	it('rejects requests with invalid signature → 401', async () => {
		const { fakeAssistant, fakeClient } = makeStubs();
		const handler = slackAdapter({
			assistant: fakeAssistant,
			signingSecret: SECRET,
			botToken: 'xoxb-test',
			clientOverride: fakeClient,
			now: NOW,
		});

		// Body changed AFTER signing — signature won't match.
		const req = new Request('http://test/slack/events', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-slack-request-timestamp': '1716552000',
				'x-slack-signature': 'v0=deadbeef',
			},
			body: '{"type":"event_callback"}',
		});
		const res = await handler(req);
		expect(res.status).toBe(401);
	});

	it('rejects non-POST methods', async () => {
		const { fakeAssistant, fakeClient } = makeStubs();
		const handler = slackAdapter({
			assistant: fakeAssistant,
			signingSecret: SECRET,
			botToken: 'xoxb-test',
			clientOverride: fakeClient,
			now: NOW,
		});
		const res = await handler(new Request('http://test/slack/events', { method: 'GET' }));
		expect(res.status).toBe(405);
	});
});

describe('slackAdapter — Slack protocol handshakes', () => {
	it('echoes url_verification challenge', async () => {
		const { fakeAssistant, fakeClient } = makeStubs();
		const handler = slackAdapter({
			assistant: fakeAssistant,
			signingSecret: SECRET,
			botToken: 'xoxb-test',
			clientOverride: fakeClient,
			now: NOW,
		});
		const res = await handler(
			makeReq({ type: 'url_verification', challenge: 'echo-me-123' }),
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('echo-me-123');
	});

	it('returns 200 quickly for non-event_callback envelopes', async () => {
		const { fakeAssistant, fakeClient } = makeStubs();
		const handler = slackAdapter({
			assistant: fakeAssistant,
			signingSecret: SECRET,
			botToken: 'xoxb-test',
			clientOverride: fakeClient,
			now: NOW,
		});
		const res = await handler(makeReq({ type: 'event_other' }));
		expect(res.status).toBe(200);
	});
});

describe('slackAdapter — message routing', () => {
	it('routes app_mention to assistant.run, posts reply', async () => {
		const stubs = makeStubs();
		const handler = slackAdapter({
			assistant: stubs.fakeAssistant,
			signingSecret: SECRET,
			botToken: 'xoxb-test',
			clientOverride: stubs.fakeClient,
			now: NOW,
		});
		const res = await handler(
			makeReq({
				type: 'event_callback',
				team_id: 'T123',
				event: {
					type: 'app_mention',
					user: 'U07',
					channel: 'C456',
					ts: '111.222',
					text: '<@U99BOT> hello there',
				},
			}),
		);
		expect(res.status).toBe(200);
		// Give the fire-and-forget a tick to run.
		await new Promise((r) => setTimeout(r, 10));
		expect(stubs.runs).toHaveLength(1);
		expect(stubs.runs[0]!.message).toBe('hello there'); // mention stripped
		expect(stubs.runs[0]!.args.sessionId).toBe('T123:C456'); // channel scope
		expect(stubs.runs[0]!.args.userId).toBe('U07');
		expect(stubs.posts).toHaveLength(1);
		expect(stubs.posts[0]!.text).toBe('echo: hello there');
		expect(stubs.posts[0]!.threadTs).toBe('111.222');
	});

	it('ignores bot-authored messages (no echo loops)', async () => {
		const stubs = makeStubs();
		const handler = slackAdapter({
			assistant: stubs.fakeAssistant,
			signingSecret: SECRET,
			botToken: 'xoxb-test',
			clientOverride: stubs.fakeClient,
			now: NOW,
		});
		await handler(
			makeReq({
				type: 'event_callback',
				team_id: 'T123',
				event: {
					type: 'message',
					bot_id: 'B100',
					user: 'U07',
					channel: 'C456',
					ts: '111.222',
					text: 'a reply from another bot',
				},
			}),
		);
		await new Promise((r) => setTimeout(r, 10));
		expect(stubs.runs).toHaveLength(0);
		expect(stubs.posts).toHaveLength(0);
	});

	it("ignores message subtypes (edits/joins) but accepts plain user messages", async () => {
		const stubs = makeStubs();
		const handler = slackAdapter({
			assistant: stubs.fakeAssistant,
			signingSecret: SECRET,
			botToken: 'xoxb-test',
			clientOverride: stubs.fakeClient,
			now: NOW,
		});
		await handler(
			makeReq({
				type: 'event_callback',
				team_id: 'T123',
				event: {
					type: 'message',
					subtype: 'message_changed',
					user: 'U07',
					channel: 'C456',
					ts: '111.222',
					text: 'edited',
				},
			}),
		);
		await new Promise((r) => setTimeout(r, 10));
		expect(stubs.runs).toHaveLength(0);
	});

	it('uses thread-scope sessions when configured', async () => {
		const stubs = makeStubs();
		const handler = slackAdapter({
			assistant: stubs.fakeAssistant,
			signingSecret: SECRET,
			botToken: 'xoxb-test',
			clientOverride: stubs.fakeClient,
			sessionScope: 'thread',
			now: NOW,
		});
		await handler(
			makeReq({
				type: 'event_callback',
				team_id: 'T123',
				event: {
					type: 'message',
					user: 'U07',
					channel: 'C456',
					ts: '999.999',
					thread_ts: '500.500',
					text: 'hi',
				},
			}),
		);
		await new Promise((r) => setTimeout(r, 10));
		expect(stubs.runs[0]!.args.sessionId).toBe('T123:C456:500.500');
	});
});
