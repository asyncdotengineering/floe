/**
 * Cloudflare D1 vector store. **CF Workers only.**
 *
 * D1 has no native vector type; we store embeddings as JSON text and
 * compute cosine similarity in JS at query time. Fine for ≤10k vectors;
 * switch to Cloudflare Vectorize (native ANN, billions of vectors) for
 * production scale.
 *
 * The D1 binding type is described structurally so this module
 * type-checks without requiring `@cloudflare/workers-types` as a hard
 * dep.
 *
 * Schema is created on first construction; safe to call repeatedly.
 */
import {
	cosineSimilarity,
	matchesFilter,
	type VectorItem,
	type VectorMatch,
	type VectorQuery,
	type VectorStore,
} from './types.ts';

interface D1PreparedStatement {
	bind(...values: unknown[]): D1PreparedStatement;
	run(): Promise<{ success: boolean; meta?: Record<string, unknown> }>;
	all<T = unknown>(): Promise<{ results: T[] }>;
	first<T = unknown>(): Promise<T | null>;
}

interface D1Database {
	prepare(query: string): D1PreparedStatement;
	exec(query: string): Promise<{ count?: number }>;
	batch<T = unknown>(statements: D1PreparedStatement[]): Promise<Array<{ results: T[] }>>;
}

export interface D1VectorStoreOptions {
	/** The D1 binding (typically `env.DB`). */
	db: D1Database;
	dimensions: number;
	/** Table name. Default 'floe_vectors'. */
	tableName?: string;
}

interface Row {
	id: string;
	text: string;
	embedding: string;
	metadata: string | null;
}

export class D1VectorStore implements VectorStore {
	readonly dimensions: number;
	private readonly db: D1Database;
	private readonly tableName: string;
	private schemaReady = false;

	constructor(opts: D1VectorStoreOptions) {
		if (!opts.db) throw new Error('[D1VectorStore] db is required');
		if (!Number.isInteger(opts.dimensions) || opts.dimensions <= 0) {
			throw new Error('[D1VectorStore] dimensions must be a positive integer');
		}
		this.db = opts.db;
		this.dimensions = opts.dimensions;
		this.tableName = opts.tableName ?? 'floe_vectors';
	}

	private async ensureSchema(): Promise<void> {
		if (this.schemaReady) return;
		await this.db.exec(
			`CREATE TABLE IF NOT EXISTS ${this.tableName} (id TEXT PRIMARY KEY, text TEXT NOT NULL, embedding TEXT NOT NULL, metadata TEXT, dimensions INTEGER NOT NULL);`,
		);
		this.schemaReady = true;
	}

	async upsert(items: VectorItem[]): Promise<void> {
		if (items.length === 0) return;
		await this.ensureSchema();
		const stmts = items.map((item) => {
			if (item.embedding.length !== this.dimensions) {
				throw new Error(
					`[D1VectorStore] embedding length ${item.embedding.length} ≠ dimensions ${this.dimensions} (id="${item.id}")`,
				);
			}
			return this.db
				.prepare(
					`INSERT INTO ${this.tableName} (id, text, embedding, metadata, dimensions) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET text=excluded.text, embedding=excluded.embedding, metadata=excluded.metadata, dimensions=excluded.dimensions`,
				)
				.bind(
					item.id,
					item.text,
					JSON.stringify(item.embedding),
					item.metadata ? JSON.stringify(item.metadata) : null,
					this.dimensions,
				);
		});
		await this.db.batch(stmts);
	}

	async query(args: VectorQuery): Promise<VectorMatch[]> {
		if (args.embedding.length !== this.dimensions) {
			throw new Error(
				`[D1VectorStore] query embedding length ${args.embedding.length} ≠ dimensions ${this.dimensions}`,
			);
		}
		await this.ensureSchema();
		const limit = args.limit ?? 10;
		const result = await this.db
			.prepare(`SELECT id, text, embedding, metadata FROM ${this.tableName}`)
			.all<Row>();
		const scored: VectorMatch[] = [];
		for (const r of result.results) {
			const metadata = r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : undefined;
			if (!matchesFilter(metadata, args.filter)) continue;
			const embedding = JSON.parse(r.embedding) as number[];
			const score = cosineSimilarity(args.embedding, embedding);
			scored.push({ id: r.id, text: r.text, score, metadata });
		}
		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, limit);
	}

	async delete(ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		await this.ensureSchema();
		const stmts = ids.map((id) =>
			this.db.prepare(`DELETE FROM ${this.tableName} WHERE id = ?`).bind(id),
		);
		await this.db.batch(stmts);
	}

	async clear(): Promise<void> {
		await this.ensureSchema();
		await this.db.prepare(`DELETE FROM ${this.tableName}`).run();
	}
}

export function d1VectorStore(opts: D1VectorStoreOptions): D1VectorStore {
	return new D1VectorStore(opts);
}
