/**
 * Turn — the load-bearing primitive of @floe/inbox.
 *
 * One Turn = one user message in → one assistant message out. Persisted
 * as one row keyed by `id`. Replaces the scattered per-turn state
 * currently held across `AssistantState`, `TranscriptStore`, and
 * observability events in `@floe/runtime`.
 *
 * Lifecycle:
 *   1. `makeTurn()` — value-object factory at request entry
 *   2. `retrieval` populated by knowledge stage
 *   3. `toolCalls` appended live as tools fire (via the SSE stream)
 *   4. `assistantText` joined from text_delta events; finalized at turn_complete
 *   5. `confidence` populated by ConfidenceScorer (CompositeConfidenceScorer default)
 *   6. `outcome` populated by finalize stage
 *   7. Persisted via ConversationStore.appendTurn(turn) at floe.turn_complete
 *
 * Turn is conceptually immutable per "row" — mutations during the turn
 * are local to the in-flight orchestrator stages; the persisted snapshot
 * is the post-finalize record.
 *
 * See REFACTOR-FIN-HARNESS.md §4.1 + §4.6 for the wire-shape contract.
 */

import type { Identity, TenantId } from './identity.ts';

// ─── Sub-shapes ──────────────────────────────────────────────────────────

export interface UserInput {
	type: 'text';
	text: string;
	receivedAt: number;
}

export interface RetrievedSource {
	id: string;
	source: string;
	score: number;
	text: string;
	metadata?: Record<string, unknown>;
}

export interface RetrievedSources {
	chunks: RetrievedSource[];
	/** True if at least one source crossed the strong-signal threshold (BM25 short-circuit). */
	strongSignal: boolean;
}

export interface ToolCallRecord {
	name: string;
	args: unknown;
	result: unknown;
	startedAt: number;
	endedAt: number;
	error?: string;
}

export type ConfidenceSource = 'self_eval' | 'retrieval' | 'triage' | 'composite';

export interface ConfidenceReason {
	signal: ConfidenceSource;
	score: number;
	note?: string;
}

export interface ConfidenceSignal {
	score: number; // 0..1
	source: ConfidenceSource;
	reasons: ConfidenceReason[];
	belowThreshold: boolean;
}

export type HandoffReason =
	| 'low_confidence'
	| 'explicit_escalate'
	| 'policy_violation'
	| 'tool_unavailable'
	| 'user_request';

export type RefusalClass =
	| 'off_topic'
	| 'unsafe'
	| 'out_of_policy'
	| 'unknown';

/**
 * Discriminated union covering every terminal state a turn can reach.
 * `in_progress` is the pre-finalize state; everything else is terminal.
 */
export type TurnOutcome =
	| { type: 'in_progress' }
	| { type: 'answered'; confidence: number }
	| { type: 'handed_off'; reason: HandoffReason; summary: string; assignee?: string }
	| { type: 'refused'; class: RefusalClass; reason: string }
	| { type: 'tool_error'; toolName: string; recoverable: boolean };

export interface TurnMetrics {
	tokensIn: number;
	tokensOut: number;
	costUsd: number;
	/** Triage confidence (0-1) captured during triage; drives CompositeConfidenceScorer. */
	triageConfidence?: number;
	stages: {
		triageMs: number;
		knowledgeMs: number;
		memoryPreloadMs: number;
		llmMs: number;
		confidenceMs: number;
		persistMs: number;
	};
	persistError?: string;
}

// ─── The Turn record itself ──────────────────────────────────────────────

export interface Turn {
	readonly id: string;
	readonly conversationId: string;
	readonly tenantId: TenantId;
	readonly identity: Identity;
	readonly startedAt: number;

	readonly input: UserInput;
	retrieval: RetrievedSources;
	toolCalls: ToolCallRecord[];
	assistantText: string | null;
	confidence: ConfidenceSignal;
	outcome: TurnOutcome;
	metrics: TurnMetrics;

	endedAt: number | null;
}

// ─── Factory ─────────────────────────────────────────────────────────────

export interface MakeTurnArgs {
	conversationId: string;
	tenantId: TenantId;
	identity: Identity;
	input: UserInput;
	id?: string;
	startedAt?: number;
}

const EMPTY_CONFIDENCE: ConfidenceSignal = {
	score: 0,
	source: 'composite',
	reasons: [],
	belowThreshold: false,
};

const EMPTY_METRICS: TurnMetrics = {
	tokensIn: 0,
	tokensOut: 0,
	costUsd: 0,
	stages: {
		triageMs: 0,
		knowledgeMs: 0,
		memoryPreloadMs: 0,
		llmMs: 0,
		confidenceMs: 0,
		persistMs: 0,
	},
};

export function makeTurn(args: MakeTurnArgs): Turn {
	const startedAt = args.startedAt ?? Date.now();
	return {
		id: args.id ?? `trn_${Math.random().toString(36).slice(2, 14)}`,
		conversationId: args.conversationId,
		tenantId: args.tenantId,
		identity: args.identity,
		startedAt,
		input: args.input,
		retrieval: { chunks: [], strongSignal: false },
		toolCalls: [],
		assistantText: null,
		confidence: { ...EMPTY_CONFIDENCE },
		outcome: { type: 'in_progress' },
		metrics: {
			...EMPTY_METRICS,
			stages: { ...EMPTY_METRICS.stages },
		},
		endedAt: null,
	};
}
