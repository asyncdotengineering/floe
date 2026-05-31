/**
 * Turn registry tests — supersession, external chain, release semantics.
 * No Flue calls; this is pure abort-controller plumbing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
	__resetTurnRegistryForTests,
	beginTurn,
	inFlightTurnCount,
} from '../src/orchestrator/turn-registry.ts';

describe('turn registry', () => {
	afterEach(() => __resetTurnRegistryForTests());

	it('first turn on a session is not superseding', () => {
		const t = beginTurn('s1');
		expect(t.supersededPrevious).toBe(false);
		expect(t.signal.aborted).toBe(false);
		t.release();
	});

	it('second turn on same session aborts the first', () => {
		const t1 = beginTurn('s1');
		const t2 = beginTurn('s1');
		expect(t2.supersededPrevious).toBe(true);
		expect(t1.signal.aborted).toBe(true);
		expect(t2.signal.aborted).toBe(false);
		t1.release();
		t2.release();
	});

	it('turns on different sessions do not interfere', () => {
		const a = beginTurn('sA');
		const b = beginTurn('sB');
		expect(a.signal.aborted).toBe(false);
		expect(b.signal.aborted).toBe(false);
		a.release();
		b.release();
	});

	it('release of a superseded turn does not evict the successor', () => {
		const t1 = beginTurn('s1');
		const t2 = beginTurn('s1');
		expect(inFlightTurnCount()).toBe(1);
		t1.release();
		expect(inFlightTurnCount()).toBe(1);
		t2.release();
		expect(inFlightTurnCount()).toBe(0);
	});

	it('release is idempotent', () => {
		const t = beginTurn('s1');
		t.release();
		t.release();
		t.release();
		expect(inFlightTurnCount()).toBe(0);
	});

	it('external signal abort propagates to the composite', () => {
		const external = new AbortController();
		const t = beginTurn('s1', external.signal);
		expect(t.signal.aborted).toBe(false);
		external.abort(new Error('client closed'));
		expect(t.signal.aborted).toBe(true);
		t.release();
	});

	it('pre-aborted external signal yields an already-aborted composite', () => {
		const external = new AbortController();
		external.abort(new Error('client closed'));
		const t = beginTurn('s1', external.signal);
		expect(t.signal.aborted).toBe(true);
		t.release();
	});
});
