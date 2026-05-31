/**
 * Per-run task delegation aggregator.
 *
 * Flue exposes `session.task()` to handlers (programmatic delegation)
 * AND auto-appends it as a tool the LLM can call (LLM-driven delegation).
 * Both emit `task` events on Flue's event stream. This module subscribes
 * once, aggregates per-runId, and drains into TurnMetrics at finalize.
 *
 * Why per-runId: a single user turn can spawn N delegated tasks. We want
 * "this turn delegated 3 sub-investigations totaling 4.2s" in one row.
 */
import { observe } from '@flue/runtime/app';
import type { FlueEvent } from '@flue/runtime';

export interface RunTaskMetrics {
	/** Number of delegated tasks that started during this run. */
	count: number;
	/** Sum of durationMs for tasks that completed during this run. */
	totalMs: number;
	/** Number of tasks that returned an error. */
	errors: number;
}

const aggregates = new Map<string, RunTaskMetrics>();
let unsubscribe: (() => void) | null = null;

function ensureBucket(runId: string): RunTaskMetrics {
	let bucket = aggregates.get(runId);
	if (!bucket) {
		bucket = { count: 0, totalMs: 0, errors: 0 };
		aggregates.set(runId, bucket);
	}
	return bucket;
}

/**
 * Register the global subscriber. Idempotent — safe to call from each
 * runtime bootstrap. Returns the unsubscribe handle.
 */
export function registerTaskTracker(): () => void {
	if (unsubscribe) return unsubscribe;
	unsubscribe = observe((event: FlueEvent, ctx) => {
		if (event.type === 'task_start') {
			ensureBucket(ctx.runId).count += 1;
			return;
		}
		if (event.type === 'task') {
			const bucket = ensureBucket(ctx.runId);
			bucket.totalMs += event.durationMs;
			if (event.isError) bucket.errors += 1;
		}
	});
	return unsubscribe;
}

/**
 * Pull the aggregate for `runId` and remove it from the map. Always
 * returns a record — runs with no delegation return zeros.
 */
export function drainRunTasks(runId: string): RunTaskMetrics {
	const bucket = aggregates.get(runId) ?? { count: 0, totalMs: 0, errors: 0 };
	aggregates.delete(runId);
	return bucket;
}

/** Test helper — clear all aggregates and unsubscribe. */
export function __resetTaskTrackerForTests(): void {
	if (unsubscribe) {
		unsubscribe();
		unsubscribe = null;
	}
	aggregates.clear();
}
