/**
 * Cloudflare Vectorize vector store. **CF Workers only.**
 *
 * Vectorize is Cloudflare's native ANN index — billions-of-vectors
 * scale, native cosine/dot/euclidean metrics. This is the recommended
 * vector store for production CF deployments.
 *
 * The binding type is described structurally; create your index ahead
 * of time with `wrangler vectorize create`, then bind it in
 * `wrangler.jsonc` as `[[vectorize]]` and pass `env.YOUR_INDEX` here.
 *
 * Note on score: Vectorize returns a similarity score that's already
 * in [-1, 1] for cosine; we normalize to [0, 1] to match the rest of
 * Floe.
 *
 * Filter shape: Vectorize supports rich filter expressions
 * (https://developers.cloudflare.com/vectorize/best-practices/insert-vectors/#metadata-filtering)
 * — we pass `filter` through verbatim. Floe's generic equality-only
 * contract is the lowest common denominator; users on Vectorize can
 * pass `{ $and: [{ userId: { $eq: 'u1' } }] }` etc.
 */
import type {
	VectorItem,
	VectorMatch,
	VectorQuery,
	VectorStore,
} from './types.ts';

interface VectorizeVector {
	id: string;
	values: number[];
	metadata?: Record<string, unknown>;
}

interface VectorizeMatch {
	id: string;
	score: number;
	values?: number[];
	metadata?: Record<string, unknown>;
}

interface VectorizeIndex {
	insert(vectors: VectorizeVector[]): Promise<{ count: number; ids: string[] }>;
	upsert(vectors: VectorizeVector[]): Promise<{ count: number; ids: string[] }>;
	query(
		vector: number[],
		options?: {
			topK?: number;
			returnValues?: boolean;
			returnMetadata?: 'none' | 'indexed' | 'all';
			filter?: Record<string, unknown>;
		},
	): Promise<{ matches: VectorizeMatch[]; count: number }>;
	getByIds(ids: string[]): Promise<VectorizeVector[]>;
	deleteByIds(ids: string[]): Promise<{ count: number; ids: string[] }>;
	describe(): Promise<{ dimensions: number; vectorsCount: number }>;
}

export interface VectorizeVectorStoreOptions {
	/** The Vectorize index binding (e.g. `env.MY_INDEX`). */
	index: VectorizeIndex;
	dimensions: number;
	/**
	 * Whether to instruct Vectorize to return metadata in matches.
	 * Default 'all'. Set 'indexed' or 'none' for cost optimization.
	 */
	returnMetadata?: 'none' | 'indexed' | 'all';
	/** Whether the search needs the chunk text back. Default true. */
	returnText?: boolean;
}

export class VectorizeVectorStore implements VectorStore {
	readonly dimensions: number;
	private readonly index: VectorizeIndex;
	private readonly returnMetadata: 'none' | 'indexed' | 'all';

	constructor(opts: VectorizeVectorStoreOptions) {
		if (!opts.index) throw new Error('[VectorizeVectorStore] index is required');
		if (!Number.isInteger(opts.dimensions) || opts.dimensions <= 0) {
			throw new Error('[VectorizeVectorStore] dimensions must be a positive integer');
		}
		this.index = opts.index;
		this.dimensions = opts.dimensions;
		this.returnMetadata = opts.returnMetadata ?? 'all';
	}

	async upsert(items: VectorItem[]): Promise<void> {
		if (items.length === 0) return;
		// We store the chunk text inside metadata as `__text` so query()
		// can return it. Vectorize itself doesn't store arbitrary
		// payloads alongside vectors — metadata is the only escape hatch.
		const vectors: VectorizeVector[] = items.map((item) => {
			if (item.embedding.length !== this.dimensions) {
				throw new Error(
					`[VectorizeVectorStore] embedding length ${item.embedding.length} ≠ dimensions ${this.dimensions} (id="${item.id}")`,
				);
			}
			return {
				id: item.id,
				values: item.embedding,
				metadata: { ...(item.metadata ?? {}), __text: item.text },
			};
		});
		await this.index.upsert(vectors);
	}

	async query(args: VectorQuery): Promise<VectorMatch[]> {
		if (args.embedding.length !== this.dimensions) {
			throw new Error(
				`[VectorizeVectorStore] query embedding length ${args.embedding.length} ≠ dimensions ${this.dimensions}`,
			);
		}
		const limit = args.limit ?? 10;
		const result = await this.index.query(args.embedding, {
			topK: limit,
			returnMetadata: this.returnMetadata,
			...(args.filter ? { filter: args.filter } : {}),
		});
		return result.matches.map((m) => {
			const metadata = m.metadata ? { ...m.metadata } : undefined;
			const text = (metadata?.__text as string | undefined) ?? '';
			if (metadata) delete metadata.__text;
			// Vectorize cosine returns -1..1. Normalize to 0..1.
			const normalized = (m.score + 1) / 2;
			return {
				id: m.id,
				text,
				score: Math.max(0, Math.min(1, normalized)),
				metadata,
			};
		});
	}

	async delete(ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		await this.index.deleteByIds(ids);
	}
}

export function vectorizeVectorStore(opts: VectorizeVectorStoreOptions): VectorizeVectorStore {
	return new VectorizeVectorStore(opts);
}
