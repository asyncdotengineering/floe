/**
 * Cross-session long-term memory primitives.
 *
 * Boundary in Floe:
 *   - SessionStore (provided by Flue) persists PER-SESSION state — message
 *     history + Floe's AssistantState in metadata. Scoped by sessionId.
 *   - MemoryService (this module) persists CROSS-SESSION knowledge —
 *     facts, summaries, preferences. Scoped by userId.
 *
 * Two integration patterns (mirrors AriaFlow + Mastra):
 *
 *   1. `preloadMemoryContext()` — fired in the orchestrator BEFORE the LLM
 *      call. Searches memory using the latest user message as query,
 *      prepends a markdown section to the system prompt. Zero extra LLM
 *      hops; voice-safe.
 *
 *   2. `createLoadMemoryTool()` — LLM-callable tool. Agent decides when
 *      to recall. Adds 1 LLM round-trip per recall; NOT voice-safe but
 *      gives the model agency. Opt-in.
 *
 * Most production conversations want #1 by default and #2 only when the
 * agent needs to retrieve disparate facts mid-turn.
 */

/** A single stored memory record. */
export interface MemoryEntry {
	/** Globally unique. */
	id: string;
	/** Which session this memory was derived from. */
	sessionId: string;
	/** Whose memory this is. Required — memory is always user-scoped. */
	userId: string;
	/**
	 * Hierarchical namespace. Lets a user's memory be split into bounded
	 * contexts (e.g. 'preferences' vs 'billing-history' vs 'support-tickets')
	 * so retrieval can target one and not pollute another. Defaults to
	 * `'default'` when ingest/search omit it.
	 */
	namespace?: string;
	/** The memory content (raw text, extracted fact, or summary). */
	content: string;
	/** Who authored the original content. */
	author?: 'user' | 'assistant' | string;
	/** Free-form filterable metadata (e.g. {topic: 'billing'}). */
	metadata?: Record<string, unknown>;
	/** ISO timestamp string (matches Flue's date convention). */
	createdAt: string;
	/** Relevance score (populated by search; not by storage). 0..1. */
	score?: number;
}

export const DEFAULT_MEMORY_NAMESPACE = 'default';

export interface SearchMemoryRequest {
	userId: string;
	query: string;
	limit?: number;
	filter?: Record<string, unknown>;
	/** Restrict search to a specific namespace. Omitted = search across all. */
	namespace?: string;
}

export interface IngestTurnInput {
	sessionId: string;
	userId: string;
	userMessage?: string;
	assistantText?: string;
	metadata?: Record<string, unknown>;
	/** Namespace to attach to ingested entries. Default: 'default'. */
	namespace?: string;
}

export interface IngestSessionInput {
	sessionId: string;
	userId: string;
	messages: Array<{
		role: 'user' | 'assistant';
		content: string;
		timestamp?: string;
	}>;
	metadata?: Record<string, unknown>;
	/** Namespace to attach to ingested entries. Default: 'default'. */
	namespace?: string;
	/**
	 * Ingestion strategy:
	 *   - 'raw': store each message as a separate memory entry (default)
	 *   - 'summarize': use an LLM to summarize the whole session into one
	 *     entry (not implemented in the in-memory reference store)
	 *   - 'extract': use an LLM to extract individual facts/entities (also
	 *     reserved for future stores)
	 */
	strategy?: 'raw' | 'summarize' | 'extract';
}

export interface MemoryService {
	/**
	 * Append a single conversational turn (user message + assistant reply)
	 * to long-term memory. The primary hook called by Floe's orchestrator
	 * after each successful turn.
	 */
	ingestTurn(input: IngestTurnInput): Promise<void>;

	/**
	 * Ingest a whole session at once. Useful for offline backfill of past
	 * conversations. Implementations MUST be idempotent — re-ingesting
	 * the same sessionId should replace prior entries from that session.
	 */
	ingestSession(input: IngestSessionInput): Promise<void>;

	/** Search the user's memory. Returns most-relevant entries first. */
	search(request: SearchMemoryRequest): Promise<MemoryEntry[]>;

	/** GDPR / data-deletion. Optional. */
	deleteForUser?(userId: string): Promise<void>;
}

/** Config attached to FloeConfig.defaults.memory or AssistantConfig.memory. */
export interface MemoryConfig {
	/** The store backend. Required if memory is enabled. */
	service: MemoryService;
	/** Token cap on preload markdown injected into the system prompt. */
	preload?: {
		maxTokens?: number;
		enabled?: boolean;
		/** Restrict preload search to this namespace. Default: search all. */
		namespace?: string;
	};
	/** Auto-ingest turn after each successful response. */
	ingest?: {
		auto?: boolean;
		strategy?: 'raw' | 'summarize' | 'extract';
		/** Namespace to ingest to. Default: 'default'. */
		namespace?: string;
	};
}
