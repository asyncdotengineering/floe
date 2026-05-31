/**
 * In-process vector store. O(N) brute-force cosine on every query.
 * Fine for ≤10k vectors; switch to SQLite / Pgvector / Vectorize beyond
 * that.
 *
 * Works on Node, Cloudflare Workers, Deno, Bun — zero deps.
 */
import {
	cosineSimilarity,
	matchesFilter,
	type VectorItem,
	type VectorMatch,
	type VectorQuery,
	type VectorStore,
} from './types.ts';

export interface InMemoryVectorStoreOptions {
	dimensions: number;
}

export class InMemoryVectorStore implements VectorStore {
	readonly dimensions: number;
	private items = new Map<string, VectorItem>();

	constructor(opts: InMemoryVectorStoreOptions) {
		if (!Number.isInteger(opts.dimensions) || opts.dimensions <= 0) {
			throw new Error('[InMemoryVectorStore] dimensions must be a positive integer');
		}
		this.dimensions = opts.dimensions;
	}

	async upsert(items: VectorItem[]): Promise<void> {
		for (const item of items) {
			if (item.embedding.length !== this.dimensions) {
				throw new Error(
					`[InMemoryVectorStore] embedding length ${item.embedding.length} does not match dimensions ${this.dimensions} (item id="${item.id}")`,
				);
			}
			this.items.set(item.id, item);
		}
	}

	async query(args: VectorQuery): Promise<VectorMatch[]> {
		if (args.embedding.length !== this.dimensions) {
			throw new Error(
				`[InMemoryVectorStore] query embedding length ${args.embedding.length} does not match dimensions ${this.dimensions}`,
			);
		}
		const limit = args.limit ?? 10;
		const scored: VectorMatch[] = [];
		for (const item of this.items.values()) {
			if (!matchesFilter(item.metadata, args.filter)) continue;
			const score = cosineSimilarity(args.embedding, item.embedding);
			scored.push({
				id: item.id,
				text: item.text,
				score,
				metadata: item.metadata,
			});
		}
		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, limit);
	}

	async delete(ids: string[]): Promise<void> {
		for (const id of ids) this.items.delete(id);
	}

	async clear(): Promise<void> {
		this.items.clear();
	}

	/** For tests / debugging. */
	size(): number {
		return this.items.size;
	}
}

export function inMemoryVectorStore(opts: InMemoryVectorStoreOptions): InMemoryVectorStore {
	return new InMemoryVectorStore(opts);
}
