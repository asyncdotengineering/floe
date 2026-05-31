/**
 * Boundary tests for the Slack signature verifier. This is the only
 * line of defense against spoofed webhooks — if it has a bug, the
 * adapter trusts attacker-controlled JSON.
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifySlackSignature } from '../src/signature.ts';

const SECRET = 'test-signing-secret';

function sign(body: string, ts: number, secret = SECRET): string {
	return 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
}

describe('verifySlackSignature', () => {
	it('accepts a freshly-signed request', () => {
		const ts = 1716552000;
		const body = '{"type":"event_callback","event":{}}';
		const headers = new Headers({
			'x-slack-request-timestamp': String(ts),
			'x-slack-signature': sign(body, ts),
		});
		const result = verifySlackSignature(headers, body, {
			signingSecret: SECRET,
			now: () => ts * 1000,
		});
		expect(result.ok).toBe(true);
	});

	it('rejects when signature does not match (wrong body)', () => {
		const ts = 1716552000;
		const headers = new Headers({
			'x-slack-request-timestamp': String(ts),
			'x-slack-signature': sign('original body', ts),
		});
		const result = verifySlackSignature(headers, 'tampered body', {
			signingSecret: SECRET,
			now: () => ts * 1000,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('signature_mismatch');
	});

	it('rejects when signed with the wrong secret', () => {
		const ts = 1716552000;
		const body = 'b';
		const headers = new Headers({
			'x-slack-request-timestamp': String(ts),
			'x-slack-signature': sign(body, ts, 'attacker-secret'),
		});
		const result = verifySlackSignature(headers, body, {
			signingSecret: SECRET,
			now: () => ts * 1000,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('signature_mismatch');
	});

	it('rejects stale timestamps (replay protection)', () => {
		const ts = 1716552000;
		const body = 'b';
		const headers = new Headers({
			'x-slack-request-timestamp': String(ts),
			'x-slack-signature': sign(body, ts),
		});
		const result = verifySlackSignature(headers, body, {
			signingSecret: SECRET,
			now: () => (ts + 1000) * 1000, // 1000 seconds later
			maxAgeSeconds: 300,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('stale_timestamp');
	});

	it('rejects requests missing signature headers', () => {
		const headers = new Headers({ 'x-slack-request-timestamp': '1716552000' });
		const result = verifySlackSignature(headers, 'b', { signingSecret: SECRET });
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('missing_headers');
	});

	it('rejects future timestamps past maxAge', () => {
		const ts = 1716552000;
		const body = 'b';
		const headers = new Headers({
			'x-slack-request-timestamp': String(ts),
			'x-slack-signature': sign(body, ts),
		});
		const result = verifySlackSignature(headers, body, {
			signingSecret: SECRET,
			now: () => (ts - 1000) * 1000,
			maxAgeSeconds: 300,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('stale_timestamp');
	});
});
