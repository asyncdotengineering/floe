/**
 * libSQL (Turso) vector store. **Works on Node + Cloudflare Workers + Deno + Bun + mobile.**
 *
 * The right "one SQLite for everywhere" choice: libSQL has **native** vector
 * primitives — `F32_BLOB(N)` column type, `vector32(...)` constructor,
 * `vector_distance_cos(...)` similarity function. Vectors live next to
 * your relational data in the same DB. No extension loading. No
 * `better-sqlite3` native compile. No `sqlite-vec` extension-loading
 * dance. The `@libsql/client` HTTP driver runs unchanged on Cloudflare
 * Workers and other edge runtimes.
 *
 * Turso (the hosted libSQL service) offers free-tier multi-tenant edge
 * SQLite with sync replicas. Local-only: just point at `file:./mem.db`
 * with the same client.
 *
 * Why this beats Floe's `SqliteVectorStore`:
 *   - Distance computed inside the DB (native float32), not in JS
 *   - Works on Cloudflare Workers (better-sqlite3 doesn't)
 *   - No native compile / no `loadExtension` ceremony
 *
 * Why this beats `D1VectorStore`:
 *   - Native vector type, not JSON-text
 *   - Same DB engine on Node + CF + edge — one schema, one client, one mental model
 *
 * Peer dep: `@libsql/client` (lazy — client is passed in by the caller).
 *
 * Scale note: this v1 uses an `ORDER BY vector_distance_cos LIMIT k`
 * full-scan query. libSQL also supports DiskANN ANN indexes via
 * `libsql_vector_idx(column)`; we can add that as an opt-in flag in
 * v1.x when we need >100k-vector scale.
 *
 * Schema (created on first use; safe to call repeatedly):
 *
 *   CREATE TABLE floe_vectors (
 *     id        TEXT PRIMARY KEY,
 *     text      TEXT NOT NULL,
 *     embedding F32_BLOB({N}) NOT NULL,
 *     metadata  TEXT             -- JSON object, or NULL
 *   );
 */
import {
	matchesFilter,
	type VectorItem,
	type VectorMatch,
	type VectorQuery,
	type VectorStore,
} from './types.ts';

// Structural type for `@libsql/client`'s `Client` so we don't take a hard
// dep on the package. The shape is shared by `@libsql/client/web` (CF) and
// `@libsql/client` (Node) — both expose `execute` and `batch`.
//
// `InValue` matches the library's actual type:
//   type InValue = string | number | null | Uint8Array | ArrayBuffer
type InValue = string | number | null | Uint8Array | ArrayBuffer | bigint;

interface LibsqlInValueRecord {
	[key: string]: InValue;
}

interface LibsqlResultSet {
	columns: string[];
	rows: LibsqlInValueRecord[];
	rowsAffected: number;
	lastInsertRowid?: bigint | null;
}

interface LibsqlClient {
	execute(
		stmt: string | { sql: string; args?: InValue[] | LibsqlInValueRecord },
	): Promise<LibsqlResultSet>;
	batch(
		stmts: Array<string | { sql: string; args?: InValue[] | LibsqlInValueRecord }>,
		mode?: 'write' | 'read' | 'deferred',
	): Promise<LibsqlResultSet[]>;
}

export interface LibSqlVectorStoreOptions {
	/** The libSQL client (typically `createClient({url, authToken})`). */
	client: LibsqlClient;
	dimensions: number;
	/** Table name. Default 'floe_vectors'. */
	tableName?: string;
	/** Skip schema creation if you manage migrations elsewhere. Default true. */
	createSchema?: boolean;
}

export class LibSqlVectorStore implements VectorStore {
	readonly dimensions: number;
	private readonly client: LibsqlClient;
	private readonly tableName: string;
	private readonly createSchema: boolean;
	private schemaReady = false;

	constructor(opts: LibSqlVectorStoreOptions) {
		if (!opts.client) throw new Error('[LibSqlVectorStore] client is required');
		if (!Number.isInteger(opts.dimensions) || opts.dimensions <= 0) {
			throw new Error('[LibSqlVectorStore] dimensions must be a positive integer');
		}
		this.client = opts.client;
		this.dimensions = opts.dimensions;
		this.tableName = opts.tableName ?? 'floe_vectors';
		this.createSchema = opts.createSchema ?? true;
	}

	private async ensureSchema(): Promise<void> {
		if (this.schemaReady) return;
		if (this.createSchema) {
			await this.client.execute(
				`CREATE TABLE IF NOT EXISTS ${this.tableName} (
					id TEXT PRIMARY KEY,
					text TEXT NOT NULL,
					embedding F32_BLOB(${this.dimensions}) NOT NULL,
					metadata TEXT
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
					`[LibSqlVectorStore] embedding length ${item.embedding.length} ≠ dimensions ${this.dimensions} (id="${item.id}")`,
				);
			}
		}
		const stmts = items.map((item) => ({
			sql: `INSERT INTO ${this.tableName} (id, text, embedding, metadata) VALUES (?, ?, vector32(?), ?) ON CONFLICT(id) DO UPDATE SET text=excluded.text, embedding=excluded.embedding, metadata=excluded.metadata`,
			args: [
				item.id,
				item.text,
				vectorToString(item.embedding),
				item.metadata ? JSON.stringify(item.metadata) : null,
			] as InValue[],
		}));
		await this.client.batch(stmts, 'write');
	}

	async query(args: VectorQuery): Promise<VectorMatch[]> {
		if (args.embedding.length !== this.dimensions) {
			throw new Error(
				`[LibSqlVectorStore] query embedding length ${args.embedding.length} ≠ dimensions ${this.dimensions}`,
			);
		}
		await this.ensureSchema();
		const limit = args.limit ?? 10;
		const queryVec = vectorToString(args.embedding);

		// Native distance in DB. ORDER BY does a full scan; switch to
		// vector_top_k() with libsql_vector_idx for ANN when scale demands.
		const fetchK = args.filter ? Math.max(limit * 4, 32) : limit;
		const res = await this.client.execute({
			sql: `SELECT id, text, metadata, vector_distance_cos(embedding, vector32(?)) AS distance FROM ${this.tableName} ORDER BY distance ASC LIMIT ?`,
			args: [queryVec, fetchK],
		});

		const out: VectorMatch[] = [];
		for (const row of res.rows) {
			const id = String(row.id);
			const text = String(row.text);
			const metadata = row.metadata
				? (JSON.parse(String(row.metadata)) as Record<string, unknown>)
				: undefined;
			if (!matchesFilter(metadata, args.filter)) continue;
			const distance = Number(row.distance);
			out.push({ id, text, score: distanceToSimilarity(distance), metadata });
			if (out.length >= limit) break;
		}
		return out;
	}

	async delete(ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		await this.ensureSchema();
		const placeholders = ids.map(() => '?').join(',');
		await this.client.execute({
			sql: `DELETE FROM ${this.tableName} WHERE id IN (${placeholders})`,
			args: ids as InValue[],
		});
	}

	async clear(): Promise<void> {
		await this.ensureSchema();
		await this.client.execute(`DELETE FROM ${this.tableName}`);
	}
}

function vectorToString(v: number[]): string {
	return `[${v.join(',')}]`;
}

/** libSQL `vector_distance_cos` returns distance ∈ [0, 2]; similarity = 1 - d/2. */
function distanceToSimilarity(distance: number): number {
	if (!Number.isFinite(distance)) return 0;
	const sim = 1 - distance / 2;
	if (sim < 0) return 0;
	if (sim > 1) return 1;
	return sim;
}

export function libSqlVectorStore(opts: LibSqlVectorStoreOptions): LibSqlVectorStore {
	return new LibSqlVectorStore(opts);
}
