/**
 * Slack request-signature verification. Slack signs every Events API
 * webhook with an HMAC-SHA256 over `v0:<timestamp>:<body>` keyed by
 * the app's signing secret. We MUST verify before treating the body
 * as trusted — otherwise anyone who knows the URL can spoof events.
 *
 * Reference: https://api.slack.com/authentication/verifying-requests-from-slack
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface VerifySlackOptions {
	signingSecret: string;
	/**
	 * Reject requests older than this many seconds (replay protection).
	 * Slack recommends 5 minutes.
	 */
	maxAgeSeconds?: number;
	/** Inject a clock for testing. Default `Date.now`. */
	now?: () => number;
}

export interface VerifyResult {
	ok: boolean;
	reason?: 'missing_headers' | 'stale_timestamp' | 'signature_mismatch';
}

export function verifySlackSignature(
	headers: Headers,
	rawBody: string,
	opts: VerifySlackOptions,
): VerifyResult {
	const timestamp = headers.get('x-slack-request-timestamp');
	const signature = headers.get('x-slack-signature');
	if (!timestamp || !signature) return { ok: false, reason: 'missing_headers' };

	const ts = parseInt(timestamp, 10);
	if (isNaN(ts)) return { ok: false, reason: 'missing_headers' };

	const maxAge = opts.maxAgeSeconds ?? 300;
	const now = Math.floor((opts.now ?? Date.now)() / 1000);
	if (Math.abs(now - ts) > maxAge) return { ok: false, reason: 'stale_timestamp' };

	const baseString = `v0:${timestamp}:${rawBody}`;
	const expected = `v0=${createHmac('sha256', opts.signingSecret).update(baseString).digest('hex')}`;
	const expectedBuf = Buffer.from(expected);
	const actualBuf = Buffer.from(signature);
	if (expectedBuf.length !== actualBuf.length) {
		return { ok: false, reason: 'signature_mismatch' };
	}
	if (!timingSafeEqual(expectedBuf, actualBuf)) {
		return { ok: false, reason: 'signature_mismatch' };
	}
	return { ok: true };
}
