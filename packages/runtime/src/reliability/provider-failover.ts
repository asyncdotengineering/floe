/**
 * Provider failover. When `FloeConfig.defaults.model` is an array, the
 * orchestrator iterates on retriable errors:
 *
 *   model: ['google/gemini-3.1-flash-lite', 'openai/gpt-4o-mini', 'anthropic/claude-haiku-4-5']
 *
 * Retriable errors (429, 5xx, network, AbortError-from-timeout) trigger
 * the next model in the chain. Non-retriable errors (4xx, validation,
 * schema-mismatch) propagate as-is — no point burning the fallback on a
 * bad request.
 *
 * This module exposes the policy + helpers; the wiring lives in
 * `orchestrator.ts` (callPromptWithFailover wraps `session.prompt`).
 */

export interface FailoverPolicy {
	/** Models to try in order. First entry is primary. */
	models: string[];
	/** Decides whether an error is retriable. Defaults to `isRetriableError`. */
	isRetriable?: (err: unknown) => boolean;
	/** Max attempts. Defaults to `models.length`. */
	maxAttempts?: number;
}

/**
 * Sensible default for what counts as retriable. Errors that match any
 * of these conditions trigger the next model:
 *   - HTTP 429 (rate limited)
 *   - HTTP 5xx (server error)
 *   - Network errors (ETIMEDOUT, ECONNRESET, ECONNREFUSED, fetch failed)
 *   - AbortError thrown by an explicit timeout
 *   - pi-ai's "context length exceeded" — try a model with bigger context
 */
export function isRetriableError(err: unknown): boolean {
	if (!err) return false;
	const e = err as Record<string, unknown>;

	// Direct HTTP status
	const status = typeof e.status === 'number' ? e.status : typeof e.httpStatus === 'number' ? e.httpStatus : undefined;
	if (status === 429) return true;
	if (typeof status === 'number' && status >= 500 && status < 600) return true;

	const message = typeof e.message === 'string' ? e.message : String(err);

	// Network-level signatures
	if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|ENOTFOUND/i.test(message)) return true;
	if (/fetch failed|network error|socket hang up/i.test(message)) return true;

	// Provider rate-limit phrasing
	if (/rate.?limit|too many requests|quota/i.test(message)) return true;
	if (/server error|overloaded|service unavailable|temporarily unavailable/i.test(message)) return true;

	// AbortError from timeouts (DOMException name === 'AbortError') — retry to next
	if ((e.name === 'AbortError' || e.code === 20) && /timeout/i.test(message)) return true;

	// Context-length: a longer-context fallback may handle it
	if (/context.length|max.tokens|too long|exceeds.+window/i.test(message)) return true;

	return false;
}

export interface FailoverAttempt<T> {
	model: string;
	startMs: number;
	endMs: number;
	error?: unknown;
	result?: T;
}

export interface FailoverResult<T> {
	/** Successful attempt, if any succeeded. */
	value: T;
	/** Model that won. */
	model: string;
	/** All attempts, in order. */
	attempts: FailoverAttempt<T>[];
}

/**
 * Run `fn(model)` over each model in the policy until one succeeds.
 * Records every attempt so callers (observability) can report which
 * fallback was used.
 */
export async function withFailover<T>(
	policy: FailoverPolicy,
	fn: (model: string) => Promise<T>,
): Promise<FailoverResult<T>> {
	const models = policy.models;
	if (models.length === 0) throw new Error('[withFailover] policy.models is empty');
	const maxAttempts = policy.maxAttempts ?? models.length;
	const isRetriable = policy.isRetriable ?? isRetriableError;
	const attempts: FailoverAttempt<T>[] = [];

	let lastError: unknown = undefined;
	for (let i = 0; i < Math.min(maxAttempts, models.length); i++) {
		const model = models[i]!;
		const attempt: FailoverAttempt<T> = { model, startMs: Date.now(), endMs: 0 };
		try {
			const value = await fn(model);
			attempt.endMs = Date.now();
			attempt.result = value;
			attempts.push(attempt);
			return { value, model, attempts };
		} catch (err) {
			attempt.endMs = Date.now();
			attempt.error = err;
			attempts.push(attempt);
			lastError = err;
			if (!isRetriable(err) || i === models.length - 1) {
				throw err;
			}
		}
	}
	// Unreachable in practice — the loop either returns or throws — but tsc needs it.
	throw lastError ?? new Error('[withFailover] exhausted attempts with no error captured');
}
