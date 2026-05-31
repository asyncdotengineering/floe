/**
 * MemoryCoordinator — owns the two-phase memory lifecycle for a turn.
 *
 * The orchestrator used to scatter memory across two stages:
 *
 *   - `retrieve.ts`     — preload context BEFORE the LLM call
 *   - `finalize-turn.ts` — ingest the (user, assistant) pair AFTER
 *
 * Each stage re-extracted the same userId, re-checked the same config,
 * handled errors independently, and shared no state. The contract
 * "preload before LLM, ingest after" was procedural — encoded across
 * two files, two callsites, and three different arg interfaces.
 *
 * The coordinator owns both phases. Callers never see `memoryCfg`
 * directly. The factory returns a no-op stub when memory isn't
 * configured, so `null` checks vanish from the orchestrator.
 *
 * Errors are swallowed by design (memory failures must NOT abort the
 * turn — the model can answer without long-term context). All failures
 * are logged + return-value-degraded.
 */
import type { MemoryConfig } from './types.ts';
import { preloadMemoryContext } from './preload.ts';

/** Result of the preload phase. */
export interface MemoryPreloadResult {
	/**
	 * Rendered context to inject into the system prompt, or `null` if
	 * there was nothing useful to preload (no userId, no userMessage,
	 * preload disabled, or memory not configured).
	 */
	context: string | null;
	/**
	 * How many memory chunks were referenced in `context`. Surfaced for
	 * observability (`memoryPreloadCount` in TurnMetrics).
	 */
	chunkCount: number;
	/** Wall-clock duration of the preload call, in ms. */
	durationMs: number;
}

/** Args for the ingest phase. */
export interface MemoryIngestArgs {
	userId: string | undefined;
	userMessage: string;
	assistantText: string;
	sessionName: string;
	/** Assistant name for ingest metadata. */
	assistantName: string;
	/** Coordination mode for ingest metadata. */
	mode: string;
	/** Routed-to role (when mode='route') for ingest metadata. */
	routedTo: string | undefined;
}

/**
 * The deep-module interface. Two methods. Hides:
 *   - the `if (cfg && userId && ...)` null-checks
 *   - the preload defaults (maxTokens=800, enabled=true)
 *   - the ingest defaults (auto=true)
 *   - error swallowing (memory failures never break the turn)
 *   - duration timing
 *   - the `memory_preloaded` observability event emission
 */
export interface MemoryCoordinator {
	/**
	 * Phase 1 — runs before the LLM call. Awaitable; the preload result
	 * is injected into the system prompt as `# Cross-session context`.
	 */
	preload(args: {
		userId: string | undefined;
		userMessage: string;
	}): Promise<MemoryPreloadResult>;
	/**
	 * Phase 2 — runs after the LLM finalizes the assistant text.
	 * Fire-and-forget; ingest is async and never blocks the response.
	 * Returns immediately with the kickoff timestamp's duration.
	 */
	ingest(args: MemoryIngestArgs): { durationMs: number };
}

/**
 * Factory. Returns a real coordinator when `cfg` is set; otherwise a
 * no-op stub so callers don't need null checks.
 */
export function createMemoryCoordinator(cfg: MemoryConfig | null): MemoryCoordinator {
	if (!cfg) return noopCoordinator;
	return new RealMemoryCoordinator(cfg);
}

class RealMemoryCoordinator implements MemoryCoordinator {
	constructor(private readonly cfg: MemoryConfig) {}

	async preload(args: {
		userId: string | undefined;
		userMessage: string;
	}): Promise<MemoryPreloadResult> {
		const start = Date.now();
		if (!args.userId || args.userMessage.trim().length === 0) {
			return { context: null, chunkCount: 0, durationMs: Date.now() - start };
		}
		const preload = this.cfg.preload ?? {};
		if (preload.enabled === false) {
			return { context: null, chunkCount: 0, durationMs: Date.now() - start };
		}
		let context: string | null = null;
		try {
			context = await preloadMemoryContext({
				service: this.cfg.service,
				userId: args.userId,
				userInput: args.userMessage,
				maxTokens: preload.maxTokens ?? 800,
				...(preload.namespace !== undefined ? { namespace: preload.namespace } : {}),
			});
		} catch (err) {
			// Memory failures must NOT abort the turn. Log + degrade.
			console.error(
				`[floe:memory] preload failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			context = null;
		}
		const chunkCount = context
			? context.split('\n').filter((l) => l.startsWith('- ')).length
			: 0;
		return { context, chunkCount, durationMs: Date.now() - start };
	}

	ingest(args: MemoryIngestArgs): { durationMs: number } {
		const start = Date.now();
		if (!args.userId || !args.assistantText) {
			return { durationMs: Date.now() - start };
		}
		if (this.cfg.ingest?.auto === false) {
			return { durationMs: Date.now() - start };
		}
		const ingestNamespace = this.cfg.ingest?.namespace;
		// Fire-and-forget — the turn closes the wire before this resolves.
		// Error swallowing is intentional; memory failures are observability
		// concerns, not turn-blocking errors.
		void this.cfg.service
			.ingestTurn({
				sessionId: args.sessionName,
				userId: args.userId,
				userMessage: args.userMessage,
				assistantText: args.assistantText,
				metadata: {
					assistantName: args.assistantName,
					mode: args.mode,
					routedTo: args.routedTo,
				},
				...(ingestNamespace !== undefined ? { namespace: ingestNamespace } : {}),
			})
			.catch((err) => {
				console.error(
					`[floe:memory] ingestTurn failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
		return { durationMs: Date.now() - start };
	}
}

/**
 * No-op coordinator returned when no memory config is set. Every method
 * is a fast return. Callers don't need to know memory was disabled.
 */
const noopCoordinator: MemoryCoordinator = {
	async preload() {
		return { context: null, chunkCount: 0, durationMs: 0 };
	},
	ingest() {
		return { durationMs: 0 };
	},
};
