/**
 * Task tracker tests — verify that Flue's `task_start` / `task` events
 * roll into a per-runId aggregate and drain into TurnMetrics cleanly.
 *
 * We avoid spinning up real Flue runs (would require LLM calls) by
 * mocking the `observe` registration and invoking the captured
 * subscriber directly with stub events.
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
	__resetTaskTrackerForTests,
	drainRunTasks,
	registerTaskTracker,
} from '../src/orchestrator/task-tracker.ts';

describe('task tracker', () => {
	beforeEach(() => {
		capturedSubscribers.length = 0;
		observeMock.mockClear();
		registerTaskTracker();
	});

	afterEach(() => {
		__resetTaskTrackerForTests();
	});

	it('returns zeros for a run with no delegation', () => {
		expect(drainRunTasks('run-empty')).toEqual({ count: 0, totalMs: 0, errors: 0 });
	});

	it('aggregates task_start + task events per runId', () => {
		const fire = (event: unknown, runId: string) =>
			capturedSubscribers.forEach((s) => s(event, { runId }));

		fire({ type: 'task_start', taskId: 't1', prompt: 'research auth' }, 'run-A');
		fire({ type: 'task_start', taskId: 't2', prompt: 'research db' }, 'run-A');
		fire({ type: 'task', taskId: 't1', isError: false, durationMs: 120 }, 'run-A');
		fire({ type: 'task', taskId: 't2', isError: true, durationMs: 80 }, 'run-A');

		expect(drainRunTasks('run-A')).toEqual({ count: 2, totalMs: 200, errors: 1 });
	});

	it('isolates aggregates by runId', () => {
		const fire = (event: unknown, runId: string) =>
			capturedSubscribers.forEach((s) => s(event, { runId }));

		fire({ type: 'task_start', taskId: 'a', prompt: 'x' }, 'run-X');
		fire({ type: 'task_start', taskId: 'b', prompt: 'y' }, 'run-Y');
		fire({ type: 'task', taskId: 'a', isError: false, durationMs: 50 }, 'run-X');

		expect(drainRunTasks('run-X')).toEqual({ count: 1, totalMs: 50, errors: 0 });
		expect(drainRunTasks('run-Y')).toEqual({ count: 1, totalMs: 0, errors: 0 });
	});

	it('drain removes the bucket so subsequent drains return zeros', () => {
		const fire = (event: unknown, runId: string) =>
			capturedSubscribers.forEach((s) => s(event, { runId }));
		fire({ type: 'task_start', taskId: 't', prompt: 'p' }, 'run-Z');
		fire({ type: 'task', taskId: 't', isError: false, durationMs: 10 }, 'run-Z');

		expect(drainRunTasks('run-Z')).toEqual({ count: 1, totalMs: 10, errors: 0 });
		expect(drainRunTasks('run-Z')).toEqual({ count: 0, totalMs: 0, errors: 0 });
	});

	it('ignores non-task events', () => {
		const fire = (event: unknown, runId: string) =>
			capturedSubscribers.forEach((s) => s(event, { runId }));
		fire({ type: 'text_delta', text: 'hello' }, 'run-N');
		fire({ type: 'run_end', isError: false }, 'run-N');
		expect(drainRunTasks('run-N')).toEqual({ count: 0, totalMs: 0, errors: 0 });
	});

	it('registers only one subscriber across multiple calls', () => {
		registerTaskTracker();
		registerTaskTracker();
		registerTaskTracker();
		expect(observeMock).toHaveBeenCalledTimes(1);
	});
});
