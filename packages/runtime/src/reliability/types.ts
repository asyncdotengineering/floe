/**
 * Reliability primitives — rate limiting + provider failover.
 *
 * Rate limiting fires BEFORE triage so a rate-limited request doesn't
 * waste any LLM cost. Provider failover lives inside `session.prompt`-
 * calling code paths in the orchestrator — when `defaults.model` is an
 * array, the orchestrator iterates on retriable errors.
 */
import type { AssistantInputEvent } from '../types.ts';

export interface RateLimitDecision {
	/** True = pass through; false = reject this turn. */
	allow: boolean;
	/** Optional reason emitted to the channel on reject. */
	reason?: string;
	/** Seconds the client should wait before retrying. */
	retryAfterSeconds?: number;
	/** Free-form metadata recorded into turn metrics for observability. */
	metadata?: Record<string, unknown>;
}

export interface RateLimiterContext {
	/** Conversation name. */
	conversation: string;
	/** Resolved userId for this turn (may be undefined). */
	userId?: string;
	/** The inbound event. Useful for keying on metadata/headers. */
	input: AssistantInputEvent;
	/** Channel name. */
	channelName: string;
}

export interface RateLimiter {
	readonly name: string;
	/** Called once per inbound turn. Should be fast — runs on the request path. */
	check(ctx: RateLimiterContext): Promise<RateLimitDecision> | RateLimitDecision;
}

/** Strongly-typed shape for an outcome the orchestrator records about a model call. */
export interface ProviderCallOutcome {
	model: string;
	durationMs: number;
	error?: ProviderError;
}

export interface ProviderError {
	/** Distinguish retriable (network/5xx/429) from non-retriable (4xx, validation). */
	retriable: boolean;
	message: string;
	cause?: unknown;
	httpStatus?: number;
}
