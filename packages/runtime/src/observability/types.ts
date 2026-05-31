/**
 * Observability primitives — per-turn structured metrics + pluggable sinks.
 *
 * The orchestrator captures stage start/end timestamps at every step
 * (route, knowledge, memory preload, prompt build, LLM call, validators,
 * post-processing), then emits a single `TurnMetrics` record at the end
 * of each turn. Sinks transport that record to wherever observability
 * lives — stderr, Sentry, Braintrust, OTel.
 *
 * Sinks are NON-BLOCKING: a slow Sentry POST does NOT slow the user
 * response. The orchestrator awaits the sinks' `record()` only if you
 * explicitly opt in via `awaitSinks: true` (rarely useful outside tests).
 */
import type { AssistantMode } from '../types.ts';

export interface TurnMetrics {
	/** Stable id from Flue's ctx.runId. */
	runId: string;
	/** AssistantConfig.name. */
	assistantName: string;
	/** Coordination mode used for this turn (direct/route/coordinate/broadcast). */
	mode: AssistantMode;
	/** Populated when mode === 'route' — the role chosen for this turn. */
	routedTo?: string | null;
	/** Active flow.name (if any). */
	flowName: string | null;
	/** Channel that handled the turn. */
	channelName: string;
	/** True when the channel marked this as a voice turn. */
	isVoice: boolean;
	/** Resolved userId (if memory was active for this turn). */
	userId: string | null;
	/** Wall-clock start (epoch ms). */
	startedAtMs: number;
	/** Wall-clock end (epoch ms). */
	endedAtMs: number;
	/** Per-stage latencies in ms. Stages that didn't run report 0. */
	stages: TurnStageLatencies;
	/** Aggregate token usage for the turn. */
	tokens: TurnTokenUsage;
	/** Models used during the turn (may be more than one if failover fired). */
	models: string[];
	/** Whether the turn produced a user-visible reply. */
	producedReply: boolean;
	/** Terminal verdict from validators ('ok' when none failed). */
	validatorVerdict: 'ok' | 'retry' | 'escalate' | 'rewrite' | 'disambiguate' | 'block';
	/** Knowledge sources hit + chunk count. */
	knowledge: { source: string; chunks: number }[];
	/** Memory: how many entries preloaded into the system prompt. */
	memoryPreloadCount: number;
	/**
	 * Delegated sub-tasks the host spawned via `delegate()` during this turn
	 * (mode='coordinate'). count=0 means no delegation happened.
	 */
	tasks: { count: number; totalMs: number; errors: number };
	/** Populated when mode === 'broadcast' — number of parallel role calls. */
	broadcastFanout?: number;
	/**
	 * Turn was aborted mid-flight. Two sources collapse here: a newer turn
	 * superseded this one on the same sessionId, or the client closed the
	 * request. See orchestrator/turn-registry.ts.
	 */
	interrupted: boolean;
	/**
	 * Auto-compactions Flue triggered during this turn. count=0 is the
	 * common case (short sessions never need to compact). count>0 with
	 * messagesDropped>>0 means we're losing history — investigate
	 * compaction.keepRecentTokens / reserveTokens.
	 */
	compaction: { count: number; totalMs: number; messagesDropped: number };
	/** Free-form tags the user attached to the inbound event. */
	tags?: Record<string, string>;
}

export interface TurnStageLatencies {
	/** Time spent on mode-specific routing (mode='route' triage call, etc). */
	triageMs: number;
	knowledgeMs: number;
	memoryPreloadMs: number;
	preLLMValidatorsMs: number;
	promptBuildMs: number;
	llmMs: number;
	postLLMValidatorsMs: number;
	memoryIngestMs: number;
	totalMs: number;
}

export interface TurnTokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalCostUsd: number;
}

export interface MetricsSink {
	readonly name: string;
	record(metrics: TurnMetrics): void | Promise<void>;
}

export interface ObservabilityConfig {
	sinks?: MetricsSink[];
	/** Defaults to false (fire-and-forget). Set true in tests for determinism. */
	awaitSinks?: boolean;
	/**
	 * Optional sampling fraction (0..1). When set < 1.0, only a random
	 * `sampleRate` proportion of turns produce metrics. Default 1.0.
	 */
	sampleRate?: number;
}
