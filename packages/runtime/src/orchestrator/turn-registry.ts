/**
 * Per-session turn cancellation registry.
 *
 * Two cancellation sources collapse into one signal per turn:
 *   1. **Supersession** — a new turn arrives on the same sessionId
 *      while the old one is still running. The old one should abort.
 *      Tracked by this module's Map<sessionId, AbortController>.
 *   2. **External** — the HTTP request itself was aborted (client
 *      disconnect, gateway timeout). Passed in via `ctx.req?.signal`.
 *
 * `beginTurn` returns a single composite signal that fires for either
 * source, plus a `release` cleanup function the orchestrator MUST call
 * in a `finally`. Failure to release is a slow leak (entries accumulate
 * across millions of turns) but does NOT cause incorrect aborts —
 * supersession always replaces by sessionId.
 */

const inFlight = new Map<string, AbortController>();

export interface BeginTurnResult {
	signal: AbortSignal;
	/** Idempotent. Safe to call from a `finally`. */
	release(): void;
	/**
	 * Was the previous in-flight turn aborted? Lets the caller log
	 * "superseded a previous in-flight turn" for observability.
	 */
	supersededPrevious: boolean;
}

export function beginTurn(sessionId: string, externalSignal?: AbortSignal): BeginTurnResult {
	const prev = inFlight.get(sessionId);
	if (prev) prev.abort(new DOMException('Superseded by a newer turn', 'AbortError'));

	const controller = new AbortController();
	inFlight.set(sessionId, controller);

	const composite = externalSignal
		? mergeSignals(controller.signal, externalSignal)
		: controller.signal;

	let released = false;
	return {
		signal: composite,
		supersededPrevious: !!prev,
		release() {
			if (released) return;
			released = true;
			// Only remove if WE are still the active controller — a turn
			// that was superseded shouldn't evict its successor's controller.
			if (inFlight.get(sessionId) === controller) {
				inFlight.delete(sessionId);
			}
		},
	};
}

/**
 * Combine two AbortSignals into one that aborts when either does. Polyfill
 * for `AbortSignal.any([a, b])` to keep Node 22 / Cloudflare / Bun all
 * happy without runtime branching.
 */
function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
	type AbortSignalWithAny = typeof AbortSignal & {
		any?: (signals: AbortSignal[]) => AbortSignal;
	};
	const cls = AbortSignal as AbortSignalWithAny;
	if (typeof cls.any === 'function') return cls.any([a, b]);
	const controller = new AbortController();
	const onAbort = (s: AbortSignal) => () => controller.abort(s.reason);
	if (a.aborted) controller.abort(a.reason);
	else a.addEventListener('abort', onAbort(a), { once: true });
	if (b.aborted) controller.abort(b.reason);
	else b.addEventListener('abort', onAbort(b), { once: true });
	return controller.signal;
}

/** Test-only — clear the registry. */
export function __resetTurnRegistryForTests(): void {
	for (const c of inFlight.values()) c.abort();
	inFlight.clear();
}

/** Diagnostic — count of in-flight turns. */
export function inFlightTurnCount(): number {
	return inFlight.size;
}
