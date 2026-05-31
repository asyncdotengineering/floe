/**
 * Generic vector-store interface.
 *
 * Both `HybridKnowledgeSource` and `VectorStoreMemoryService` consume
 * this interface — pick any backend (in-memory / sqlite / D1 / Pgvector
 * / Cloudflare Vectorize) and both higher-level primitives work.
 *
 * Vectors are upserted by id. Metadata is opaque to the store except
 * for filtering (stores that don't support filters MUST document the
 * limitation; in-memory and sqlite do, D1 / Vectorize / Pgvector support
 * native filter expressions).
 */

export interface VectorItem {
	/** Globally unique. Same id on upsert replaces. */
	id: string;
	/** The vector. Length MUST equal the store's `dimensions`. */
	embedding: number[];
	/** Original text (returned in matches; used for reranking). */
	text: string;
	/** Free-form metadata. Used for `filter`. Store-dependent shape limits. */
	metadata?: Record<string, unknown>;
}

export interface VectorMatch {
	id: string;
	text: string;
	/** Cosine similarity in [0, 1]. Normalized so 1.0 = identical. */
	score: number;
	metadata?: Record<string, unknown>;
}

export interface VectorQuery {
	embedding: number[];
	/** Max matches to return. Default 10. */
	limit?: number;
	/** Match metadata exactly. Equality only — stores supporting richer ops document it. */
	filter?: Record<string, unknown>;
}

export interface VectorStore {
	/** Vector dimension this store was configured for. */
	readonly dimensions: number;
	upsert(items: VectorItem[]): Promise<void>;
	query(args: VectorQuery): Promise<VectorMatch[]>;
	delete(ids: string[]): Promise<void>;
	/** Optional: drop everything. Useful for tests / re-index flows. */
	clear?(): Promise<void>;
}

/** Helper: cosine similarity for in-process vector stores. */
export function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length) return 0;
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i]! * b[i]!;
		na += a[i]! * a[i]!;
		nb += b[i]! * b[i]!;
	}
	const denom = Math.sqrt(na) * Math.sqrt(nb);
	if (denom === 0) return 0;
	// Cosine in [-1, 1]; normalize to [0, 1] so it composes with BM25's normalized score.
	return (dot / denom + 1) / 2;
}

/** Shared metadata filter check. Equality only. */
export function matchesFilter(
	metadata: Record<string, unknown> | undefined,
	filter: Record<string, unknown> | undefined,
): boolean {
	if (!filter) return true;
	const md = metadata ?? {};
	for (const [k, v] of Object.entries(filter)) {
		if (md[k] !== v) return false;
	}
	return true;
}
