/**
 * Generic reranker interface. Implementations score `candidates` against
 * the `query` and return the same ids with scores in [0, 1].
 *
 * Floe's `HybridKnowledgeSource` calls reranker AFTER BM25+vector fusion
 * to re-order the top candidates. Reranker quality usually beats fused
 * RRF rank on heads-up evals — the trade-off is one extra latency hop.
 */
export interface RerankCandidate {
	id: string;
	text: string;
}

export interface RerankResult {
	id: string;
	score: number;
}

export interface Reranker {
	readonly name: string;
	rerank(args: {
		query: string;
		candidates: RerankCandidate[];
		limit?: number;
	}): Promise<RerankResult[]>;
}
