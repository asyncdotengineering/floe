/**
 * Floe's per-assistant auxiliary state — `turnCount`, `activeFlow`,
 * `pendingTransition`, `activeProcedures`, `metrics`. The state the
 * orchestrator carries between turns to know what flow the user is
 * mid-way through, what procedures matched, etc.
 *
 * Persistence happens through `AssistantStateStore` (see
 * `./assistant-state-store.ts`). The orchestrator loads at turn
 * start, mutates in memory, and saves at turn end (write-behind).
 */
import type { AssistantState } from './types.ts';

export function freshState(args: {
	assistantName: string;
	channelName: string;
}): AssistantState {
	return {
		version: 1,
		assistantName: args.assistantName,
		channelName: args.channelName,
		startedAt: new Date().toISOString(),
		turnCount: 0,
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
	};
}
