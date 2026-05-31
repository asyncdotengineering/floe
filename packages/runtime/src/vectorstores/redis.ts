/**
 * Redis vector store. Backed by **Redis Search** (Redis Stack / Redis ≥ 8)
 * native vector indexing — `FT.CREATE ... VECTOR HNSW` + `FT.SEARCH ...
 * KNN`. Real ANN; not the cosine-in-JS shortcut.
 *
 * Client-agnostic via a single structural `RedisCommandRunner` interface
 * — wrap whatever library you use:
 *
 *   // ioredis
 *   const client: RedisCommandRunner = {
 *     command: (args) => redis.callBuffer(String(args[0]), ...args.slice(1)),
 *   };
 *
 *   // node-redis v4
 *   const client: RedisCommandRunner = {
 *     command: (args) => nodeRedis.sendCommand(args as string[]),
 *   };
 *
 *   // @upstash/redis (HTTP, works on CF Workers)
 *   const client: RedisCommandRunner = {
 *     command: (args) => upstash.send(args[0] as string, args.slice(1)),
 *   };
 *
 * Schema (created on first use):
 *
 *   FT.CREATE <idx> ON HASH PREFIX 1 <keyPrefix>
 *     SCHEMA
 *       embedding VECTOR HNSW 6 TYPE FLOAT32 DIM <N> DISTANCE_METRIC COSINE
 *       text     TEXT
 *       metadata TEXT
 *
 * Storage layout (one HASH per vector):
 *
 *   HSET <keyPrefix><id>
 *     embedding <float32 binary>
 *     text      "<chunk text>"
 *     metadata  "{...json...}"
 *
 * Filters: equality-only via Redis Search tag/text predicate. We attach
 * `userId` and other top-level metadata keys as `@<key>:{<value>}` style
 * filter expressions when set. Stores with richer filter needs should
 * subclass and override `buildFilter`.
 */
import {
	type VectorItem,
	type VectorMatch,
	type VectorQuery,
	type VectorStore,
} from './types.ts';

export interface RedisCommandRunner {
	command(args: Array<string | Uint8Array>): Promise<unknown>;
}

export interface RedisVectorStoreOptions {
	client: RedisCommandRunner;
	dimensions: number;
	/** Search index name. Default 'floe-vectors-idx'. */
	indexName?: string;
	/** HASH key prefix. Default 'floe:vec:'. */
	keyPrefix?: string;
	/** ANN algorithm. Default 'HNSW' (recall/latency winner; FLAT is brute force). */
	algorithm?: 'HNSW' | 'FLAT';
	/** Skip schema creation if you manage migrations elsewhere. Default true. */
	createSchema?: boolean;
}

export class RedisVectorStore implements VectorStore {
	readonly dimensions: number;
	private readonly client: RedisCommandRunner;
	private readonly indexName: string;
	private readonly keyPrefix: string;
	private readonly algorithm: 'HNSW' | 'FLAT';
	private readonly createSchema: boolean;
	private schemaReady = false;

	constructor(opts: RedisVectorStoreOptions) {
		if (!opts.client) throw new Error('[RedisVectorStore] client is required');
		if (!Number.isInteger(opts.dimensions) || opts.dimensions <= 0) {
			throw new Error('[RedisVectorStore] dimensions must be a positive integer');
		}
		this.client = opts.client;
		this.dimensions = opts.dimensions;
		this.indexName = opts.indexName ?? 'floe-vectors-idx';
		this.keyPrefix = opts.keyPrefix ?? 'floe:vec:';
		this.algorithm = opts.algorithm ?? 'HNSW';
		this.createSchema = opts.createSchema ?? true;
	}

	private async ensureSchema(): Promise<void> {
		if (this.schemaReady) return;
		if (this.createSchema) {
			try {
				await this.client.command([
					'FT.CREATE',
					this.indexName,
					'ON', 'HASH',
					'PREFIX', '1', this.keyPrefix,
					'SCHEMA',
					'embedding', 'VECTOR', this.algorithm, '6',
					'TYPE', 'FLOAT32',
					'DIM', String(this.dimensions),
					'DISTANCE_METRIC', 'COSINE',
					'text', 'TEXT',
					'metadata', 'TEXT',
				]);
			} catch (err) {
				// FT.CREATE throws "Index already exists" on re-runs; that's fine.
				const message = err instanceof Error ? err.message : String(err);
				if (!/already exists|Index name already exists/i.test(message)) {
					throw err;
				}
			}
		}
		this.schemaReady = true;
	}

	async upsert(items: VectorItem[]): Promise<void> {
		if (items.length === 0) return;
		await this.ensureSchema();
		for (const item of items) {
			if (item.embedding.length !== this.dimensions) {
				throw new Error(
					`[RedisVectorStore] embedding length ${item.embedding.length} ≠ dimensions ${this.dimensions} (id="${item.id}")`,
				);
			}
			await this.client.command([
				'HSET',
				`${this.keyPrefix}${item.id}`,
				'embedding', encodeVector(item.embedding),
				'text', item.text,
				'metadata', item.metadata ? JSON.stringify(item.metadata) : '{}',
			]);
		}
	}

	async query(args: VectorQuery): Promise<VectorMatch[]> {
		if (args.embedding.length !== this.dimensions) {
			throw new Error(
				`[RedisVectorStore] query embedding length ${args.embedding.length} ≠ dimensions ${this.dimensions}`,
			);
		}
		await this.ensureSchema();
		const limit = args.limit ?? 10;
		// Build query string: filter prefix + KNN clause. Redis Search
		// requires `(*)` as the wildcard prefix when no text filter is
		// active. With a metadata filter we still wrap KNN in the
		// post-filter pattern: `(<filter>)=>[KNN ...]`.
		const filterClause = '(*)'; // post-fetch JS filter below — keeps backend filter-shape generic
		const queryString = `${filterClause}=>[KNN ${limit} @embedding $blob AS __score]`;
		const result = (await this.client.command([
			'FT.SEARCH',
			this.indexName,
			queryString,
			'PARAMS', '2', 'blob', encodeVector(args.embedding),
			'SORTBY', '__score', 'ASC',
			'RETURN', '3', '__score', 'text', 'metadata',
			'DIALECT', '2',
			'LIMIT', '0', String(limit * (args.filter ? 4 : 1)),
		])) as unknown;
		const parsed = parseSearchReply(result, this.keyPrefix);
		const out: VectorMatch[] = [];
		for (const match of parsed) {
			if (args.filter && !matchesFilter(match.metadata, args.filter)) continue;
			out.push(match);
			if (out.length >= limit) break;
		}
		return out;
	}

	async delete(ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		await this.ensureSchema();
		for (const id of ids) {
			await this.client.command(['DEL', `${this.keyPrefix}${id}`]);
		}
	}

	async clear(): Promise<void> {
		await this.ensureSchema();
		// Drop the index AND its docs (Redis Search DD flag).
		try {
			await this.client.command(['FT.DROPINDEX', this.indexName, 'DD']);
		} catch {
			/* index may not exist — fine */
		}
		this.schemaReady = false;
	}
}

export function redisVectorStore(opts: RedisVectorStoreOptions): RedisVectorStore {
	return new RedisVectorStore(opts);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Encode a number[] embedding to a little-endian Float32 byte sequence —
 * the wire format Redis Search expects for VECTOR fields. Returns a
 * Uint8Array (compatible with Buffer everywhere). Works on Node + CF +
 * Deno + Bun.
 */
function encodeVector(embedding: number[]): Uint8Array {
	const buf = new ArrayBuffer(embedding.length * 4);
	const view = new DataView(buf);
	for (let i = 0; i < embedding.length; i++) {
		view.setFloat32(i * 4, embedding[i]!, true /* little-endian */);
	}
	return new Uint8Array(buf);
}

interface ParsedDoc {
	id: string;
	text: string;
	score: number;
	metadata?: Record<string, unknown>;
}

/**
 * Parse the Redis Search FT.SEARCH response shape:
 *   [
 *     totalCount,
 *     <docKey>, [field, value, field, value, ...],
 *     <docKey>, [field, value, ...],
 *     ...
 *   ]
 *
 * Handles both string and Buffer/Uint8Array field values (varies by
 * client library). Skips malformed entries silently.
 */
function parseSearchReply(reply: unknown, keyPrefix: string): VectorMatch[] {
	if (!Array.isArray(reply) || reply.length < 1) return [];
	const out: VectorMatch[] = [];
	// First element is total count — start from index 1.
	for (let i = 1; i < reply.length; i += 2) {
		const rawKey = reply[i];
		const fields = reply[i + 1];
		if (!Array.isArray(fields)) continue;
		const key = bufferOrStringToString(rawKey);
		const id = key.startsWith(keyPrefix) ? key.slice(keyPrefix.length) : key;
		const doc: ParsedDoc = { id, text: '', score: 0 };
		for (let j = 0; j < fields.length; j += 2) {
			const fieldName = bufferOrStringToString(fields[j]);
			const fieldValue = bufferOrStringToString(fields[j + 1]);
			if (fieldName === '__score') {
				// Redis returns cosine distance ∈ [0, 2]. Normalize to similarity ∈ [0, 1].
				const distance = Number(fieldValue);
				doc.score = distanceToSimilarity(distance);
			} else if (fieldName === 'text') {
				doc.text = fieldValue;
			} else if (fieldName === 'metadata') {
				try {
					const parsed = JSON.parse(fieldValue) as Record<string, unknown>;
					doc.metadata = parsed;
				} catch {
					/* tolerate corrupt metadata; leave undefined */
				}
			}
		}
		out.push({ id: doc.id, text: doc.text, score: doc.score, metadata: doc.metadata });
	}
	return out;
}

function bufferOrStringToString(v: unknown): string {
	if (v == null) return '';
	if (typeof v === 'string') return v;
	if (v instanceof Uint8Array) {
		return new TextDecoder().decode(v);
	}
	return String(v);
}

/** Redis cosine distance ∈ [0, 2]; similarity = 1 - d/2. */
function distanceToSimilarity(distance: number): number {
	if (!Number.isFinite(distance)) return 0;
	const sim = 1 - distance / 2;
	if (sim < 0) return 0;
	if (sim > 1) return 1;
	return sim;
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
