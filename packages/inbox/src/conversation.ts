/**
 * Conversation lifecycle — independent of HTTP request lifetime.
 *
 * A Conversation is the long-lived shell that holds Turns. Its status
 * transitions are time-driven (idle/abandoned via scheduled probe or
 * lazy-on-read check) AND event-driven (escalate fires synchronously
 * from a Turn outcome).
 *
 * Per REFACTOR-FIN-HARNESS §4.2.
 *
 * Idle window defaults: 5 min idle, 24h abandoned. Tunable per inbox
 * config at `defineInbox({ lifecycle: { idleMs, abandonedMs } })`.
 */

import type { Identity, TenantId } from './identity.ts';
import type { TurnOutcome } from './turn.ts';

export type ConversationStatus =
	| 'active' // last turn within idle window
	| 'idle' // > idleMs since last user input
	| 'abandoned' // > abandonedMs idle and no resolution
	| 'escalated' // human has it
	| 'closed'; // resolved or human closed it

export interface ConversationOutcomesRollup {
	answered: number;
	escalated: number;
	refused: number;
	toolError: number;
}

export interface Conversation {
	id: string;
	tenantId: TenantId;
	identity: Identity;
	status: ConversationStatus;
	startedAt: number;
	lastActivityAt: number;
	resolvedAt: number | null;
	escalatedAt: number | null;
	closedAt: number | null;
	turnCount: number;
	outcomes: ConversationOutcomesRollup;
}

export interface ConversationLifecycleConfig {
	idleMs: number;
	abandonedMs: number;
}

export const DEFAULT_LIFECYCLE: ConversationLifecycleConfig = {
	idleMs: 5 * 60 * 1000, // 5 min
	abandonedMs: 24 * 60 * 60 * 1000, // 24h
};

// ─── Factory ─────────────────────────────────────────────────────────────

export interface MakeConversationArgs {
	id?: string;
	tenantId: TenantId;
	identity: Identity;
	startedAt?: number;
}

export function makeConversation(args: MakeConversationArgs): Conversation {
	const startedAt = args.startedAt ?? Date.now();
	return {
		id: args.id ?? `conv_${Math.random().toString(36).slice(2, 14)}`,
		tenantId: args.tenantId,
		identity: args.identity,
		status: 'active',
		startedAt,
		lastActivityAt: startedAt,
		resolvedAt: null,
		escalatedAt: null,
		closedAt: null,
		turnCount: 0,
		outcomes: { answered: 0, escalated: 0, refused: 0, toolError: 0 },
	};
}

// ─── Transition events ───────────────────────────────────────────────────

export type ConversationTransitionEvent =
	| { type: 'user_input'; at: number }
	| { type: 'turn_complete'; at: number; outcome: TurnOutcome }
	| { type: 'time_check'; at: number }
	| { type: 'human_close'; at: number };

/**
 * Pure function — given a Conversation and an event, returns the next
 * Conversation state. Does NOT mutate input. Caller persists the result.
 *
 * Transition rules:
 *   - user_input              → active (resets lastActivityAt)
 *   - turn_complete answered  → active, turnCount++, outcomes.answered++
 *   - turn_complete handed_off → escalated (terminal-ish; can re-open)
 *   - turn_complete refused   → active, outcomes.refused++
 *   - turn_complete tool_error → active, outcomes.toolError++
 *   - time_check (now - lastActivityAt > idleMs)         → idle
 *   - time_check (now - lastActivityAt > abandonedMs)    → abandoned
 *   - human_close              → closed
 *
 * Once `closed`, no further transitions (returns input unchanged).
 * Once `escalated`, only `user_input` (re-open) or `human_close` apply.
 */
export function transitionConversationStatus(
	conversation: Conversation,
	event: ConversationTransitionEvent,
	lifecycle: ConversationLifecycleConfig = DEFAULT_LIFECYCLE,
): Conversation {
	if (conversation.status === 'closed') return conversation;

	switch (event.type) {
		case 'user_input': {
			// re-opens from escalated/idle/abandoned
			return {
				...conversation,
				status: 'active',
				lastActivityAt: event.at,
			};
		}
		case 'turn_complete': {
			const next: Conversation = {
				...conversation,
				lastActivityAt: event.at,
				turnCount: conversation.turnCount + 1,
				outcomes: { ...conversation.outcomes },
			};
			switch (event.outcome.type) {
				case 'in_progress':
					return next; // shouldn't happen; defensive no-op
				case 'answered':
					next.outcomes.answered += 1;
					next.status = 'active';
					return next;
				case 'handed_off':
					next.outcomes.escalated += 1;
					next.status = 'escalated';
					next.escalatedAt = event.at;
					return next;
				case 'refused':
					next.outcomes.refused += 1;
					next.status = 'active';
					return next;
				case 'tool_error':
					next.outcomes.toolError += 1;
					next.status = 'active';
					return next;
			}
			return next;
		}
		case 'time_check': {
			const idleFor = event.at - conversation.lastActivityAt;
			if (conversation.status === 'escalated') return conversation;
			if (idleFor > lifecycle.abandonedMs && conversation.status !== 'abandoned') {
				return { ...conversation, status: 'abandoned' };
			}
			if (
				idleFor > lifecycle.idleMs &&
				conversation.status === 'active'
			) {
				return { ...conversation, status: 'idle' };
			}
			return conversation;
		}
		case 'human_close': {
			return {
				...conversation,
				status: 'closed',
				closedAt: event.at,
				resolvedAt: conversation.resolvedAt ?? event.at,
			};
		}
	}
}
