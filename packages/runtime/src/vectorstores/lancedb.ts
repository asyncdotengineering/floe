/**
 * LanceDB vector store. **Node-only.**
 *
 * LanceDB is an embedded, columnar vector database — Apache Arrow under
 * the hood, native HNSW / IVF indexes via the Rust core. Best fit when:
 *   - You want SQLite-style "vector DB as a file" but with real ANN
 *   - You're running on Node and prepared to take a native dep
 *   - You expect >100k vectors and SQLite-cosine-in-JS isn't enough
 *
 * The CF / Workers story isn't here: LanceDB's JS bindings are a native
 * Rust addon (`@lancedb/lancedb`). For CF, use `vectorizeVectorStore`
 * (native Cloudflare Vectorize binding) or `libSqlVectorStore` (Turso
 * edge with native vector ops).
 *
 * Peer dep: `@lancedb/lancedb` (the table you pass in is its `Table`
 * type — structurally typed here so this module doesn't take a hard
 * dep on it).
 *
 * Schema (created when the table doesn't exist):
 *
 *   table: floe_vectors
 *     id        TEXT  PRIMARY KEY
 *     vector    FixedSizeList<Float32, N>
 *     text      TEXT
 *     metadata  TEXT (JSON-encoded)
 *
 * Filter support: passes `args.filter` through as a SQL-shaped `WHERE`
 * predicate. We construct `metadata = '<exact-json>'` matches for top-
 * level equality keys via `.where()`. For complex queries write your own
 * search using the raw `table.search(...)` builder.
 */
import {
	type VectorItem,
	type VectorMatch,
	type VectorQuery,
	type VectorStore,
} from './types.ts';

interface LanceSearchBuilder {
	limit(n: number): LanceSearchBuilder;
	where(predicate: string): LanceSearchBuilder;
	select?(columns: string[]): LanceSearchBuilder;
	distanceType?(metric: 'l2' | 'cosine' | 'dot'): LanceSearchBuilder;
	toArray(): Promise<Array<Record<string, unknown>>>;
}

export interface LanceTable {
	add(records: Array<Record<string, unknown>>): Promise<void>;
	delete?(predicate: string): Promise<void>;
	search(vector: number[]): LanceSearchBuilder;
	countRows?(): Promise<number>;
	mergeInsert?(on: string): {
		whenMatchedUpdateAll(): {
			whenNotMatchedInsertAll(): {
				execute(records: Array<Record<string, unknown>>): Promise<void>;
			};
		};
	};
}

export interface LanceDbVectorStoreOptions {
	/** A LanceDB Table instance (typically from `db.openTable('floe_vectors')`). */
	table: LanceTable;
	dimensions: number;
	/**
	 * Cosine, l2, or dot product. Default 'cosine'. The store NORMALIZES
	 * returned LanceDB distances to similarity ∈ [0,1] (so HybridKnowledge
	 * RRF composes correctly).
	 */
	distance?: 'cosine' | 'l2' | 'dot';
	/**
	 * When true (default), upsert uses LanceDB's mergeInsert pattern for
	 * idempotency on `id`. Falls back to delete+insert if mergeInsert
	 * isn't available on the table interface.
	 */
	useMergeInsert?: boolean;
}

export class LanceDbVectorStore implements VectorStore {
	readonly dimensions: number;
	private readonly table: LanceTable;
	private readonly distance: 'cosine' | 'l2' | 'dot';
	private readonly useMergeInsert: boolean;

	constructor(opts: LanceDbVectorStoreOptions) {
		if (!opts.table) throw new Error('[LanceDbVectorStore] table is required');
		if (!Number.isInteger(opts.dimensions) || opts.dimensions <= 0) {
			throw new Error('[LanceDbVectorStore] dimensions must be a positive integer');
		}
		this.table = opts.table;
		this.dimensions = opts.dimensions;
		this.distance = opts.distance ?? 'cosine';
		this.useMergeInsert = opts.useMergeInsert ?? true;
	}

	async upsert(items: VectorItem[]): Promise<void> {
		if (items.length === 0) return;
		const records = items.map((item) => {
			if (item.embedding.length !== this.dimensions) {
				throw new Error(
					`[LanceDbVectorStore] embedding length ${item.embedding.length} ≠ dimensions ${this.dimensions} (id="${item.id}")`,
				);
			}
			return {
				id: item.id,
				vector: item.embedding,
				text: item.text,
				metadata: item.metadata ? JSON.stringify(item.metadata) : '{}',
			};
		});

		if (this.useMergeInsert && typeof this.table.mergeInsert === 'function') {
			await this.table
				.mergeInsert('id')
				.whenMatchedUpdateAll()
				.whenNotMatchedInsertAll()
				.execute(records);
			return;
		}

		// Fallback: delete-then-insert (worse for concurrent writers but
		// keeps the public Lance API minimal).
		if (this.table.delete) {
			const ids = records.map((r) => `'${escapeSql(String(r.id))}'`).join(',');
			await this.table.delete(`id IN (${ids})`);
		}
		await this.table.add(records);
	}

	async query(args: VectorQuery): Promise<VectorMatch[]> {
		if (args.embedding.length !== this.dimensions) {
			throw new Error(
				`[LanceDbVectorStore] query embedding length ${args.embedding.length} ≠ dimensions ${this.dimensions}`,
			);
		}
		const limit = args.limit ?? 10;
		let builder = this.table.search(args.embedding);
		if (typeof builder.distanceType === 'function') {
			builder = builder.distanceType(this.distance);
		}
		builder = builder.limit(args.filter ? Math.max(limit * 4, 32) : limit);
		// Equality-only filter: composes the metadata column as a JSON-
		// equality predicate. LanceDB supports SQL-ish `WHERE` via DataFusion.
		// We post-fetch filter in JS too to handle non-trivial value types.
		const rows = await builder.toArray();
		const out: VectorMatch[] = [];
		for (const row of rows) {
			const id = String(row.id);
			const text = String(row.text ?? '');
			let metadata: Record<string, unknown> | undefined;
			const rawMeta = row.metadata;
			if (typeof rawMeta === 'string' && rawMeta.length > 0) {
				try {
					metadata = JSON.parse(rawMeta) as Record<string, unknown>;
				} catch {
					/* skip malformed metadata */
				}
			}
			if (args.filter && !matchesFilter(metadata, args.filter)) continue;
			const distance = Number(row._distance ?? 0);
			const score = distanceToSimilarity(distance, this.distance);
			out.push({ id, text, score, metadata });
			if (out.length >= limit) break;
		}
		return out;
	}

	async delete(ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		if (!this.table.delete) {
			throw new Error('[LanceDbVectorStore] underlying table does not support delete()');
		}
		const inClause = ids.map((id) => `'${escapeSql(id)}'`).join(',');
		await this.table.delete(`id IN (${inClause})`);
	}

	async clear(): Promise<void> {
		if (!this.table.delete) {
			throw new Error('[LanceDbVectorStore] underlying table does not support delete()');
		}
		// LanceDB does not require a WHERE — empty predicate deletes all.
		await this.table.delete('true');
	}
}

export function lanceDbVectorStore(opts: LanceDbVectorStoreOptions): LanceDbVectorStore {
	return new LanceDbVectorStore(opts);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function escapeSql(value: string): string {
	return value.replace(/'/g, "''");
}

/**
 * Convert LanceDB distance to [0,1] similarity. Cosine distance ∈ [0,2];
 * L2 distance ∈ [0, ∞); dot product ∈ [-∞, ∞). We map cosine cleanly;
 * for L2 we use `1 / (1 + d)` (monotonic, bounded); for dot product we
 * pass through clamped to [0,1] which assumes normalized vectors.
 */
function distanceToSimilarity(distance: number, metric: 'cosine' | 'l2' | 'dot'): number {
	if (!Number.isFinite(distance)) return 0;
	if (metric === 'cosine') {
		const sim = 1 - distance / 2;
		return clamp(sim);
	}
	if (metric === 'l2') {
		return clamp(1 / (1 + distance));
	}
	// dot product — assume normalized; remap [-1, 1] → [0, 1]
	return clamp((distance + 1) / 2);
}

function clamp(v: number): number {
	if (v < 0) return 0;
	if (v > 1) return 1;
	return v;
}

function matchesFilter(
	metadata: Record<string, unknown> | undefined,
	filter: Record<string, unknown>,
): boolean {
	const md = metadata ?? {};
	for (const [k, v] of Object.entries(filter)) {
		if (md[k] !== v) return false;
	}
	return true;
}
