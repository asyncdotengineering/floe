/**
 * Shared types for orchestrator stage composition.
 * Used by the four stage modules under orchestrator/.
 */

import type { FlueHarness, FlueSession } from '@flue/runtime';
import type {
	AssistantMode,
	AssistantOutputEvent,
	AssistantState,
	AssistantView,
	Flow,
	KnowledgeChunk,
	Procedure,
	Transition,
} from '../types.ts';
import type {
	TurnMetrics,
	TurnStageLatencies,
} from '../observability/types.ts';
import type { MemoryCoordinator } from '../memory/coordinator.ts';

export interface PrepareTurnOutput {
	session: FlueSession;
	/**
	 * The Flue harness that owns the session. Exposed so the orchestrator
	 * can build a `delegate` tool that spawns child sessions for role
	 * delegation (sidesteps Flue 0.7's broken `task` tool — see
	 * orchestrator/delegate-tool.ts).
	 */
	harness: FlueHarness;
	state: AssistantState;
	events: AssistantOutputEvent[];
	userMessage: string;
	respondingTo: string;
	/** Coordination mode resolved for this turn (overlay > assistant default > 'direct'). */
	mode: AssistantMode;
	/** Populated when mode === 'route' — the role chosen for this turn. */
	routedTo: string | undefined;
	isVoice: boolean;
	userId: string | undefined;
	stages: TurnStageLatencies;
	turnStart: number;
	memory: MemoryCoordinator;
	overlay: {
		transcriptionCorrection?: string;
		compaction?: { reserveTokens?: number; keepRecentTokens?: number };
	};
	/**
	 * Composite abort signal — fires when (a) a newer turn supersedes
	 * this one on the same sessionId, or (b) the inbound HTTP request
	 * is aborted (`ctx.req?.signal`). Threaded into `session.prompt` and
	 * Floe tool contexts so any LLM call / tool execution cancels
	 * promptly when the user gives up or types again.
	 */
	signal: AbortSignal;
}

export interface RetrieveOutput {
	matchedProcedures: {
		procedure: Procedure;
		metadata: { name: string };
		body: string;
	}[];
	knowledgeChunks: KnowledgeChunk[];
	memoryContext: string | null;
	memoryPreloadCount: number;
	knowledgeUsage: TurnMetrics['knowledge'];
	stages: TurnStageLatencies;
	events: AssistantOutputEvent[];
}

export interface RespondOutput {
	assistantText: string;
	userMessage: string; // post-validator (may be rewritten by PII redaction)
	events: AssistantOutputEvent[];
	stages: TurnStageLatencies;
	totalUsageInput: number;
	totalUsageOutput: number;
	totalUsageCacheRead: number;
	totalUsageCacheWrite: number;
	totalUsageCost: number;
	llmTotalMs: number;
	promptBuildTotalMs: number;
	lastFinalizedTransition: Transition | null;
	modelsUsed: string[];
	validatorVerdict: TurnMetrics['validatorVerdict'];
}

export interface FinalizeTurnContext {
	session: FlueSession;
	convo: { name: string; systemPrompt: string; flows?: Flow[] | undefined };
	state: AssistantState;
	events: AssistantOutputEvent[];
	userMessage: string;
	respondingTo: string;
	mode: AssistantMode;
	routedTo: string | undefined;
	isVoice: boolean;
	userId: string | undefined;
	stages: TurnStageLatencies;
	turnStart: number;
	memory: MemoryCoordinator;
	assistantText: string;
	lastFinalizedTransition: Transition | null;
	totalUsageInput: number;
	totalUsageOutput: number;
	totalUsageCacheRead: number;
	totalUsageCacheWrite: number;
	totalUsageCost: number;
	modelsUsed: string[];
	validatorVerdict: TurnMetrics['validatorVerdict'];
	knowledgeUsage: TurnMetrics['knowledge'];
	memoryPreloadCount: number;
	assistantStateStore: { save(sessionId: string, state: AssistantState): Promise<void> };
	transcriptStore?: {
		append(sessionId: string, msg: { id: string; role: string; parts: { type: string; text: string }[]; createdAt: number; userId?: string }): Promise<void>;
	};
	observability?: { sinks?: { name: string; record(m: TurnMetrics): void | Promise<void> }[]; sampleRate?: number; awaitSinks?: boolean };
	sessionId: string;
	ctxRunId: string;
	defaultsModel: string;
	defaults: { model: string };
	view: AssistantView;
}

export type RespondOrFailure =
	| { kind: 'success'; output: RespondOutput }
	| { kind: 'failure'; result: { text: string; respondingTo: string; events: AssistantOutputEvent[]; state: AssistantState } };
