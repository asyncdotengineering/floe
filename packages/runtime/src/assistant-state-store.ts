/**
 * AssistantStateStore — durable storage for Floe's per-assistant
 * auxiliary state (turnCount, activeFlow, pendingTransition,
 * activeProcedures, metrics).
 *
 * Design — write-behind:
 *   1. Orchestrator calls `load(sessionId)` once at turn start.
 *   2. State is mutated in-memory during the turn.
 *   3. Orchestrator calls `save(sessionId, state)` once at turn end.
 *
 * One read + one write per turn. No mid-turn checkpoints.
 *
 * `InMemoryAssistantStateStore` is process-local: fine for dev,
 * single-worker Node, or CF Durable Objects (single-writer per DO).
 * For multi-worker Node + serverless deploys, use @floe/state-libsql
 * (or another durable backend).
 */
import type { AssistantState } from '@floe/runtime';

export interface AssistantStateStore {
	load(sessionId: string): Promise<AssistantState | null>;
	save(sessionId: string, state: AssistantState): Promise<void>;
}

export class InMemoryAssistantStateStore implements AssistantStateStore {
	private readonly entries = new Map<string, AssistantState>();
	async load(sessionId: string): Promise<AssistantState | null> {
		return this.entries.get(sessionId) ?? null;
	}
	async save(sessionId: string, state: AssistantState): Promise<void> {
		this.entries.set(sessionId, state);
	}
}
