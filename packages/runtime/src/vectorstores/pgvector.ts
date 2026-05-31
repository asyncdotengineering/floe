/**
 * PostgreSQL + pgvector vector store. **Node** (and Cloudflare Workers
 * via Hyperdrive — the same client surface works through a Hyperdrive
 * binding-injected connection string).
 *
 * Uses real ANN (cosine via `<=>`) when an index is present. Schema:
 *
 *   CREATE EXTENSION IF NOT EXISTS vector;
 *   CREATE TABLE floe_vectors (
 *     id          TEXT PRIMARY KEY,
 *     text        TEXT NOT NULL,
 *     embedding   VECTOR(N) NOT NULL,
 *     metadata    JSONB
 *   );
 *   CREATE INDEX ON floe_vectors USING hnsw (embedding vector_cosine_ops);
 *
 * Peer dep: a PG client exposing `.query(sql, params)`. The official
 * `pg` library, `postgres.js`, and `@neondatabase/serverless` all
 * satisfy this. We type the client structurally so users don't have to
 * install `@types/pg` if they're on `postgres.js`.
 *
 * Pgvector cosine distance is in [0, 2]; we normalize to similarity in
 * [0, 1] as `1 - (distance / 2)`.
 *
 * Filter is equality-only on top-level metadata keys, expressed as
 * `metadata @> $N` (JSONB containment). Anything richer: write your
 * own query and pass an opt-out flag in a future revision.
 */
import type {
	VectorItem,
	VectorMatch,
	VectorQuery,
	VectorStore,
} from './types.ts';

interface PgClient {
	query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface PgvectorStoreOptions {
	client: PgClient;
	dimensions: number;
	tableName?: string;
	/** Set to `false` to skip schema creation — useful if you manage migrations elsewhere. Default true. */
	createSchema?: boolean;
}

interface Row {
	id: string;
	text: string;
	distance: number;
	metadata: Record<string, unknown> | null;
}

export class PgvectorStore implements VectorStore {
	readonly dimensions: number;
	private readonly client: PgClient;
	private readonly tableName: string;
	private readonly createSchema: boolean;
	private schemaReady = false;

	constructor(opts: PgvectorStoreOptions) {
		if (!opts.client) throw new Error('[PgvectorStore] client is required');
		if (!Number.isInteger(opts.dimensions) || opts.dimensions <= 0) {
			throw new Error('[PgvectorStore] dimensions must be a positive integer');
		}
		this.client = opts.client;
		this.dimensions = opts.dimensions;
		this.tableName = opts.tableName ?? 'floe_vectors';
		this.createSchema = opts.createSchema ?? true;
	}

	private async ensureSchema(): Promise<void> {
		if (this.schemaReady) return;
		if (this.createSchema) {
			await this.client.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
			await this.client.query(
				`CREATE TABLE IF NOT EXISTS ${this.tableName} (
					id TEXT PRIMARY KEY,
					text TEXT NOT NULL,
					embedding VECTOR(${this.dimensions}) NOT NULL,
					metadata JSONB
				);`,
			);
		}
		this.schemaReady = true;
	}

	async upsert(items: VectorItem[]): Promise<void> {
		if (items.length === 0) return;
		await this.ensureSchema();
		for (const item of items) {
			if (item.embedding.length !== this.dimensions) {
				throw new Error(
					`[PgvectorStore] embedding length ${item.embedding.length} ≠ dimensions ${this.dimensions} (id="${item.id}")`,
				);
			}
		}
		// Build a batched INSERT … ON CONFLICT … in a single statement.
		const placeholders: string[] = [];
		const params: unknown[] = [];
		let p = 1;
		for (const item of items) {
			placeholders.push(`($${p++}, $${p++}, $${p++}::vector, $${p++}::jsonb)`);
			params.push(
				item.id,
				item.text,
				vectorToString(item.embedding),
				item.metadata ? JSON.stringify(item.metadata) : null,
			);
		}
		const sql = `INSERT INTO ${this.tableName} (id, text, embedding, metadata) VALUES ${placeholders.join(',')} ON CONFLICT (id) DO UPDATE SET text=EXCLUDED.text, embedding=EXCLUDED.embedding, metadata=EXCLUDED.metadata`;
		await this.client.query(sql, params);
	}

	async query(args: VectorQuery): Promise<VectorMatch[]> {
		if (args.embedding.length !== this.dimensions) {
			throw new Error(
				`[PgvectorStore] query embedding length ${args.embedding.length} ≠ dimensions ${this.dimensions}`,
			);
		}
		await this.ensureSchema();
		const limit = args.limit ?? 10;
		const params: unknown[] = [vectorToString(args.embedding)];
		let where = '';
		if (args.filter && Object.keys(args.filter).length > 0) {
			params.push(JSON.stringify(args.filter));
			where = `WHERE metadata @> $${params.length}::jsonb`;
		}
		params.push(limit);
		const sql = `SELECT id, text, metadata, embedding <=> $1::vector AS distance FROM ${this.tableName} ${where} ORDER BY embedding <=> $1::vector LIMIT $${params.length}`;
		const result = await this.client.query<Row>(sql, params);
		return result.rows.map((r) => ({
			id: r.id,
			text: r.text,
			score: distanceToSimilarity(Number(r.distance)),
			metadata: r.metadata ?? undefined,
		}));
	}

	async delete(ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		await this.ensureSchema();
		await this.client.query(`DELETE FROM ${this.tableName} WHERE id = ANY($1)`, [ids]);
	}

	async clear(): Promise<void> {
		await this.ensureSchema();
		await this.client.query(`DELETE FROM ${this.tableName}`);
	}
}

function vectorToString(v: number[]): string {
	return `[${v.join(',')}]`;
}

/** pgvector cosine distance ∈ [0, 2]; similarity ∈ [0, 1] = 1 - d/2. */
function distanceToSimilarity(distance: number): number {
	if (!Number.isFinite(distance)) return 0;
	const sim = 1 - distance / 2;
	if (sim < 0) return 0;
	if (sim > 1) return 1;
	return sim;
}

export function pgVectorStore(opts: PgvectorStoreOptions): PgvectorStore {
	return new PgvectorStore(opts);
}
