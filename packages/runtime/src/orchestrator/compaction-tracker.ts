/**
 * Per-run compaction aggregator.
 *
 * Flue auto-compacts long sessions to stay under the model's context
 * window. Without telemetry we can't tell whether long conversations
 * are degrading silently (compaction firing too often or dropping
 * critical context). This module subscribes to Flue's `compaction`
 * events, aggregates by runId, and drains into TurnMetrics.compaction
 * at finalize-turn.
 *
 * Mirror of orchestrator/task-tracker.ts — same observe() pattern,
 * different event shape. Kept separate so each file stays focused on
 * one concern.
 */
import { observe } from '@flue/runtime/app';
import type { FlueEvent } from '@flue/runtime';

export interface RunCompactionMetrics {
	/** Number of compactions that completed during this run. */
	count: number;
	/** Sum of durationMs for compactions during this run. */
	totalMs: number;
	/** Total messages removed across all compactions (before - after summed). */
	messagesDropped: number;
}

const aggregates = new Map<string, RunCompactionMetrics>();
let unsubscribe: (() => void) | null = null;

function ensureBucket(runId: string): RunCompactionMetrics {
	let bucket = aggregates.get(runId);
	if (!bucket) {
		bucket = { count: 0, totalMs: 0, messagesDropped: 0 };
		aggregates.set(runId, bucket);
	}
	return bucket;
}

export function registerCompactionTracker(): () => void {
	if (unsubscribe) return unsubscribe;
	unsubscribe = observe((event: FlueEvent, ctx) => {
		if (event.type === 'compaction') {
			const bucket = ensureBucket(ctx.runId);
			bucket.count += 1;
			bucket.totalMs += event.durationMs;
			bucket.messagesDropped += Math.max(0, event.messagesBefore - event.messagesAfter);
		}
	});
	return unsubscribe;
}

export function drainRunCompactions(runId: string): RunCompactionMetrics {
	const bucket = aggregates.get(runId) ?? { count: 0, totalMs: 0, messagesDropped: 0 };
	aggregates.delete(runId);
	return bucket;
}

export function __resetCompactionTrackerForTests(): void {
	if (unsubscribe) {
		unsubscribe();
		unsubscribe = null;
	}
	aggregates.clear();
}
