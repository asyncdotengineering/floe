/**
 * Compaction tracker tests — mirror of task-tracker.test.ts for the
 * `compaction` event stream. Confirms per-runId aggregation, drain
 * semantics, and that we drop the right delta when messagesAfter >
 * messagesBefore (shouldn't happen but stay defensive).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { observeMock, capturedSubscribers } = vi.hoisted(() => {
	const subs: Array<(event: unknown, ctx: unknown) => void> = [];
	return {
		capturedSubscribers: subs,
		observeMock: vi.fn((subscriber: (event: unknown, ctx: unknown) => void) => {
			subs.push(subscriber);
			return () => {
				const i = subs.indexOf(subscriber);
				if (i >= 0) subs.splice(i, 1);
			};
		}),
	};
});

vi.mock('@flue/runtime/app', async () => {
	const actual = await vi.importActual<typeof import('@flue/runtime/app')>('@flue/runtime/app');
	return { ...actual, observe: observeMock };
});

import {
	__resetCompactionTrackerForTests,
	drainRunCompactions,
	registerCompactionTracker,
} from '../src/orchestrator/compaction-tracker.ts';

describe('compaction tracker', () => {
	beforeEach(() => {
		capturedSubscribers.length = 0;
		observeMock.mockClear();
		registerCompactionTracker();
	});

	afterEach(() => {
		__resetCompactionTrackerForTests();
	});

	it('returns zeros for a run with no compaction', () => {
		expect(drainRunCompactions('run-empty')).toEqual({
			count: 0, totalMs: 0, messagesDropped: 0,
		});
	});

	it('aggregates count, duration, and messages dropped', () => {
		const fire = (event: unknown, runId: string) =>
			capturedSubscribers.forEach((s) => s(event, { runId }));
		fire(
			{ type: 'compaction', messagesBefore: 40, messagesAfter: 12, durationMs: 800 },
			'run-A',
		);
		fire(
			{ type: 'compaction', messagesBefore: 25, messagesAfter: 8, durationMs: 600 },
			'run-A',
		);
		expect(drainRunCompactions('run-A')).toEqual({
			count: 2,
			totalMs: 1400,
			messagesDropped: 45,
		});
	});

	it('clamps a negative delta to 0', () => {
		const fire = (event: unknown, runId: string) =>
			capturedSubscribers.forEach((s) => s(event, { runId }));
		fire(
			{ type: 'compaction', messagesBefore: 5, messagesAfter: 7, durationMs: 100 },
			'run-W',
		);
		expect(drainRunCompactions('run-W').messagesDropped).toBe(0);
	});

	it('isolates aggregates by runId', () => {
		const fire = (event: unknown, runId: string) =>
			capturedSubscribers.forEach((s) => s(event, { runId }));
		fire({ type: 'compaction', messagesBefore: 10, messagesAfter: 3, durationMs: 50 }, 'run-X');
		fire({ type: 'compaction', messagesBefore: 8, messagesAfter: 2, durationMs: 40 }, 'run-Y');
		expect(drainRunCompactions('run-X').count).toBe(1);
		expect(drainRunCompactions('run-Y').count).toBe(1);
	});

	it('ignores non-compaction events', () => {
		const fire = (event: unknown, runId: string) =>
			capturedSubscribers.forEach((s) => s(event, { runId }));
		fire({ type: 'compaction_start', reason: 'threshold', estimatedTokens: 1000 }, 'run-N');
		fire({ type: 'task', taskId: 't', isError: false, durationMs: 10 }, 'run-N');
		expect(drainRunCompactions('run-N')).toEqual({ count: 0, totalMs: 0, messagesDropped: 0 });
	});

	it('registers only one subscriber across multiple calls', () => {
		registerCompactionTracker();
		registerCompactionTracker();
		expect(observeMock).toHaveBeenCalledTimes(1);
	});
});
