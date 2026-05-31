/**
 * Unit tests for the hybrid semantic assertions. We verify the literal
 * fast path WITHOUT invoking the LLM judge (no FlueSession provided in
 * the fast-path cases). Judge-fallback path is verified through a stub
 * session that records calls + returns canned verdicts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import {
	semanticContains,
	semanticMatches,
	semanticNotContains,
} from '../src/eval/semantic.ts';
import type { AssertionContext } from '../src/eval/types.ts';

const ctx = (text: string): AssertionContext => ({
	text,
	allTexts: [text],
	events: [],
	state: {
		version: 1,
		assistantName: 'test',
		channelName: 'test',
		startedAt: '',
		turnCount: 1,
		activeFlow: null,
		activeProcedures: [],
		pendingTransition: null,
		metrics: {
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalCostUsd: 0,
			lastTurnLatencyMs: 0,
			interruptionCount: 0,
		},
	},
	metrics: [],
});

/** Stub judge that records calls + returns a canned verdict. */
function stubJudge(verdict: { pass: boolean; reasoning: string }) {
	const calls: { prompt: string; variant: string }[] = [];
	const judge = async (args: { prompt: string; variant: string }) => {
		calls.push(args);
		return verdict;
	};
	return { calls, judge };
}

const TMP_CACHE = '/tmp/_floe-semantic-test-cache.json';

afterEach(() => {
	try {
		rmSync(TMP_CACHE);
	} catch {
		// noop
	}
});

describe('semanticContains — literal fast path', () => {
	it('PASS without invoking judge when literal substring is present', async () => {
		const stub = stubJudge({ pass: false, reasoning: 'should not be called' });
		const a = semanticContains('size', { intent: 'mentions sizing', judge: stub.judge, cachePath: false });
		const r = await a.check(ctx('Your usual size will fit.'));
		expect(r.pass).toBe(true);
		expect(stub.calls).toHaveLength(0);
	});
});

describe('semanticContains — judge fallback', () => {
	it('escalates to judge when literal missed and overrides PASS', async () => {
		const stub = stubJudge({ pass: true, reasoning: 'reply gives sizing advice via "sizing down"' });
		const a = semanticContains('size', { intent: 'mentions sizing advice', judge: stub.judge, cachePath: false });
		const r = await a.check(ctx('We recommend sizing down to a small.'));
		expect(r.pass).toBe(true);
		expect(r.message).toMatch(/literal "size" missing; judge overrode/);
		expect(stub.calls).toHaveLength(1);
	});
	it('FAIL when literal missed AND judge confirms', async () => {
		const stub = stubJudge({ pass: false, reasoning: 'reply ignores the question' });
		const a = semanticContains('size', { intent: 'mentions sizing advice', judge: stub.judge, cachePath: false });
		const r = await a.check(ctx('I have no information about that.'));
		expect(r.pass).toBe(false);
		expect(r.message).toMatch(/judge ruled FAIL/);
	});
});

describe('semanticNotContains — judge fallback', () => {
	it('PASS without judge when literal absent', async () => {
		const stub = stubJudge({ pass: false, reasoning: 'should not be called' });
		const a = semanticNotContains('Tokyo', { intent: 'no weather info', judge: stub.judge, cachePath: false });
		const r = await a.check(ctx('I am the Acme concierge — happy to help with apparel.'));
		expect(r.pass).toBe(true);
		expect(stub.calls).toHaveLength(0);
	});
	it('escalates when literal present; judge override = PASS for false-positive', async () => {
		const stub = stubJudge({
			pass: true,
			reasoning: 'Tokyo mentioned only as a destination cue, not as weather discussion',
		});
		const a = semanticNotContains('Tokyo', {
			intent: 'reply must NOT discuss weather',
			judge: stub.judge,
			cachePath: false,
		});
		const r = await a.check(ctx('Looking for travel-ready pieces for Tokyo?'));
		expect(r.pass).toBe(true);
		expect(r.message).toMatch(/judge ruled false-positive/);
	});
});

describe('semanticMatches — judge fallback', () => {
	it('PASS without judge when regex matches', async () => {
		const stub = stubJudge({ pass: false, reasoning: 'should not be called' });
		const a = semanticMatches(/refund|processed/i, {
			intent: 'confirms refund processed',
			judge: stub.judge,
			cachePath: false,
		});
		const r = await a.check(ctx('Done — your refund has been processed.'));
		expect(r.pass).toBe(true);
		expect(stub.calls).toHaveLength(0);
	});
	it('judge can override when regex missed but semantics are clean', async () => {
		const stub = stubJudge({
			pass: true,
			reasoning: 'reply uses "all taken care of" which means refund processed in context',
		});
		const a = semanticMatches(/refund|processed/i, {
			intent: 'confirms refund processed',
			judge: stub.judge,
			cachePath: false,
		});
		const r = await a.check(ctx("All taken care of — you'll see the credit shortly."));
		expect(r.pass).toBe(true);
	});
});

describe('judge cache', () => {
	it('second identical assertion does not re-invoke the judge', async () => {
		const stub = stubJudge({ pass: true, reasoning: 'cached verdict' });
		const a = semanticContains('size', {
			intent: 'mentions sizing advice',
			judge: stub.judge,
			cachePath: TMP_CACHE,
		});
		const text = 'We recommend sizing down to a small.';
		await a.check(ctx(text));
		await a.check(ctx(text));
		expect(stub.calls).toHaveLength(1);
	});
});
