import { describe, expect, it } from 'vitest';
import { InMemoryVectorStore } from '../src/vectorstores/in-memory.ts';
import { D1VectorStore } from '../src/vectorstores/d1.ts';
import { VectorizeVectorStore } from '../src/vectorstores/vectorize.ts';
import { PgvectorStore } from '../src/vectorstores/pgvector.ts';
import { LibSqlVectorStore } from '../src/vectorstores/libsql.ts';
import { cosineSimilarity, matchesFilter } from '../src/vectorstores/types.ts';

describe('vectorstores: cosineSimilarity', () => {
	it('returns 1 for identical vectors (after [-1,1]→[0,1] normalization → 1)', () => {
		expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 5);
	});
	it('returns 0.5 for orthogonal vectors', () => {
		expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.5, 5);
	});
	it('returns 0 for opposite vectors', () => {
		expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(0, 5);
	});
	it('returns 0 for mismatched lengths', () => {
		expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
	});
});

describe('vectorstores: matchesFilter', () => {
	it('returns true when filter is undefined', () => {
		expect(matchesFilter({ a: 1 }, undefined)).toBe(true);
	});
	it('matches when all filter keys equal metadata values', () => {
		expect(matchesFilter({ a: 1, b: 2 }, { a: 1 })).toBe(true);
	});
	it('rejects on any mismatch', () => {
		expect(matchesFilter({ a: 1 }, { a: 2 })).toBe(false);
	});
});

describe('vectorstores: InMemoryVectorStore', () => {
	it('upsert + query returns ranked matches', async () => {
		const store = new InMemoryVectorStore({ dimensions: 2 });
		await store.upsert([
			{ id: 'a', embedding: [1, 0], text: 'A' },
			{ id: 'b', embedding: [0.9, 0.1], text: 'B' },
			{ id: 'c', embedding: [0, 1], text: 'C' },
		]);
		const matches = await store.query({ embedding: [1, 0], limit: 2 });
		expect(matches.map((m) => m.id)).toEqual(['a', 'b']);
		expect(matches[0]!.score).toBeGreaterThan(matches[1]!.score);
	});

	it('honors metadata filter', async () => {
		const store = new InMemoryVectorStore({ dimensions: 2 });
		await store.upsert([
			{ id: 'u1', embedding: [1, 0], text: 'A', metadata: { userId: 'u1' } },
			{ id: 'u2', embedding: [1, 0], text: 'B', metadata: { userId: 'u2' } },
		]);
		const matches = await store.query({
			embedding: [1, 0],
			filter: { userId: 'u2' },
		});
		expect(matches.map((m) => m.id)).toEqual(['u2']);
	});

	it('rejects wrong-dimensions upsert', async () => {
		const store = new InMemoryVectorStore({ dimensions: 2 });
		await expect(
			store.upsert([{ id: 'x', embedding: [1, 0, 0], text: '' }]),
		).rejects.toThrow(/dimensions/);
	});

	it('upsert by same id replaces', async () => {
		const store = new InMemoryVectorStore({ dimensions: 2 });
		await store.upsert([{ id: 'a', embedding: [1, 0], text: 'first' }]);
		await store.upsert([{ id: 'a', embedding: [0, 1], text: 'second' }]);
		expect(store.size()).toBe(1);
		const [match] = await store.query({ embedding: [0, 1], limit: 1 });
		expect(match!.text).toBe('second');
	});

	it('delete + clear', async () => {
		const store = new InMemoryVectorStore({ dimensions: 2 });
		await store.upsert([
			{ id: 'a', embedding: [1, 0], text: '' },
			{ id: 'b', embedding: [0, 1], text: '' },
		]);
		await store.delete(['a']);
		expect(store.size()).toBe(1);
		await store.clear();
		expect(store.size()).toBe(0);
	});
});

describe('vectorstores: D1VectorStore (mock binding)', () => {
	/**
	 * The mock captures statement.sql + bound params at .bind() time and
	 * dispatches them at .batch() / .all() / .run() time — that's how the
	 * real D1 binding works.
	 */
	function mockD1() {
		const rows = new Map<string, { id: string; text: string; embedding: string; metadata: string | null }>();
		const execLog: string[] = [];

		function makeStmt(sql: string) {
			let bound: unknown[] = [];
			const stmt = {
				sql,
				get bindings() { return bound; },
				bind(...vals: unknown[]) {
					bound = vals;
					return stmt;
				},
				async run() {
					applyStatement(sql, bound);
					return { success: true };
				},
				async all<T = unknown>() {
					if (/^SELECT/i.test(sql)) {
						return { results: Array.from(rows.values()) as unknown as T[] };
					}
					return { results: [] as T[] };
				},
				async first<T = unknown>() { return null as T | null; },
			};
			return stmt;
		}

		function applyStatement(sql: string, b: unknown[]): void {
			if (/^INSERT INTO/i.test(sql)) {
				const [id, text, embedding, metadata] = b;
				rows.set(String(id), {
					id: String(id),
					text: String(text),
					embedding: String(embedding),
					metadata: metadata == null ? null : String(metadata),
				});
				return;
			}
			if (/^DELETE FROM .* WHERE id = \?/i.test(sql)) {
				rows.delete(String(b[0]));
				return;
			}
			if (/^DELETE FROM/i.test(sql)) {
				rows.clear();
			}
		}

		return {
			rows,
			execLog,
			async exec(query: string) {
				execLog.push(query);
				return { count: 0 };
			},
			prepare(sql: string) { return makeStmt(sql); },
			async batch<T = unknown>(statements: ReturnType<typeof makeStmt>[]) {
				for (const s of statements) applyStatement(s.sql, s.bindings);
				return statements.map(() => ({ results: [] as T[] }));
			},
		};
	}

	it('creates schema via exec on first use', async () => {
		const db = mockD1();
		const store = new D1VectorStore({ db: db as unknown as Parameters<typeof D1VectorStore>[0]['db'], dimensions: 2 });
		await store.upsert([{ id: 'a', embedding: [1, 0], text: 'A' }]);
		expect(db.execLog.some((s) => /CREATE TABLE IF NOT EXISTS/i.test(s))).toBe(true);
	});

	it('upsert + query returns ranked matches via JS-side cosine', async () => {
		const db = mockD1();
		const store = new D1VectorStore({ db: db as unknown as Parameters<typeof D1VectorStore>[0]['db'], dimensions: 2 });
		await store.upsert([
			{ id: 'a', embedding: [1, 0], text: 'first' },
			{ id: 'b', embedding: [0, 1], text: 'second' },
		]);
		const matches = await store.query({ embedding: [1, 0], limit: 1 });
		expect(matches).toHaveLength(1);
		expect(matches[0]!.id).toBe('a');
		expect(matches[0]!.score).toBeGreaterThan(0.99);
	});

	it('honors metadata filter', async () => {
		const db = mockD1();
		const store = new D1VectorStore({ db: db as unknown as Parameters<typeof D1VectorStore>[0]['db'], dimensions: 2 });
		await store.upsert([
			{ id: 'a', embedding: [1, 0], text: 'A', metadata: { userId: 'u1' } },
			{ id: 'b', embedding: [1, 0], text: 'B', metadata: { userId: 'u2' } },
		]);
		const matches = await store.query({ embedding: [1, 0], filter: { userId: 'u2' } });
		expect(matches.map((m) => m.id)).toEqual(['b']);
	});

	it('rejects wrong dimensions on upsert', async () => {
		const db = mockD1();
		const store = new D1VectorStore({ db: db as unknown as Parameters<typeof D1VectorStore>[0]['db'], dimensions: 4 });
		await expect(
			store.upsert([{ id: 'a', embedding: [1, 0], text: '' }]),
		).rejects.toThrow(/dimensions/);
	});

	it('delete + clear', async () => {
		const db = mockD1();
		const store = new D1VectorStore({ db: db as unknown as Parameters<typeof D1VectorStore>[0]['db'], dimensions: 2 });
		await store.upsert([
			{ id: 'a', embedding: [1, 0], text: '' },
			{ id: 'b', embedding: [0, 1], text: '' },
		]);
		await store.delete(['a']);
		expect(db.rows.has('a')).toBe(false);
		expect(db.rows.has('b')).toBe(true);
		await store.clear();
		expect(db.rows.size).toBe(0);
	});
});

describe('vectorstores: VectorizeVectorStore (mock binding)', () => {
	function mockIndex(): {
		store: Map<string, { id: string; values: number[]; metadata?: Record<string, unknown> }>;
		api: Parameters<typeof VectorizeVectorStore>[0]['index'];
	} {
		const store = new Map<string, { id: string; values: number[]; metadata?: Record<string, unknown> }>();
		return {
			store,
			api: {
				async insert(vectors) {
					for (const v of vectors) store.set(v.id, v);
					return { count: vectors.length, ids: vectors.map((v) => v.id) };
				},
				async upsert(vectors) {
					for (const v of vectors) store.set(v.id, v);
					return { count: vectors.length, ids: vectors.map((v) => v.id) };
				},
				async query(vector, options) {
					const all = Array.from(store.values());
					const cosine = (a: number[], b: number[]) => {
						let dot = 0, na = 0, nb = 0;
						for (let i = 0; i < a.length; i++) {
							dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!;
						}
						return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
					};
					const scored = all
						.filter((v) => {
							if (!options?.filter) return true;
							for (const [k, val] of Object.entries(options.filter)) {
								if (v.metadata?.[k] !== val) return false;
							}
							return true;
						})
						.map((v) => ({ id: v.id, score: cosine(vector, v.values), metadata: v.metadata }))
						.sort((a, b) => b.score - a.score)
						.slice(0, options?.topK ?? 10);
					return { matches: scored, count: scored.length };
				},
				async getByIds(ids) {
					return ids.map((id) => store.get(id)).filter((v): v is NonNullable<typeof v> => !!v);
				},
				async deleteByIds(ids) {
					for (const id of ids) store.delete(id);
					return { count: ids.length, ids };
				},
				async describe() {
					return { dimensions: 2, vectorsCount: store.size };
				},
			},
		};
	}

	it('upsert stores __text in metadata; query reconstructs', async () => {
		const { api } = mockIndex();
		const store = new VectorizeVectorStore({ index: api, dimensions: 2 });
		await store.upsert([
			{ id: 'a', embedding: [1, 0], text: 'apple', metadata: { topic: 'fruit' } },
			{ id: 'b', embedding: [0, 1], text: 'beach', metadata: { topic: 'place' } },
		]);
		const matches = await store.query({ embedding: [1, 0], limit: 2 });
		expect(matches[0]!.text).toBe('apple');
		expect(matches[0]!.metadata?.topic).toBe('fruit');
		expect((matches[0]!.metadata as Record<string, unknown>).__text).toBeUndefined();
	});

	it('filter passes through to the binding', async () => {
		const { api } = mockIndex();
		const store = new VectorizeVectorStore({ index: api, dimensions: 2 });
		await store.upsert([
			{ id: 'a', embedding: [1, 0], text: 'A', metadata: { userId: 'u1' } },
			{ id: 'b', embedding: [1, 0], text: 'B', metadata: { userId: 'u2' } },
		]);
		const matches = await store.query({ embedding: [1, 0], filter: { userId: 'u2' } });
		expect(matches.map((m) => m.id)).toEqual(['b']);
	});
});

describe('vectorstores: PgvectorStore (mock client)', () => {
	function mockPg() {
		const rows = new Map<string, { id: string; text: string; embedding: number[]; metadata: Record<string, unknown> | null }>();
		const queries: Array<{ text: string; params?: unknown[] }> = [];
		return {
			queries,
			rows,
			async query<T = unknown>(text: string, params?: unknown[]) {
				queries.push({ text, params });
				if (text.startsWith('CREATE EXTENSION') || text.startsWith('CREATE TABLE')) {
					return { rows: [] as T[] };
				}
				if (text.startsWith('INSERT INTO')) {
					// params come in groups of 4: id, text, embedding-str, metadata-str
					for (let i = 0; i < (params?.length ?? 0); i += 4) {
						const id = String(params![i]);
						const t = String(params![i + 1]);
						const embStr = String(params![i + 2]).replace(/^\[|\]$/g, '');
						const emb = embStr.split(',').map(Number);
						const mdStr = params![i + 3] as string | null;
						const md = mdStr ? (JSON.parse(mdStr) as Record<string, unknown>) : null;
						rows.set(id, { id, text: t, embedding: emb, metadata: md });
					}
					return { rows: [] as T[] };
				}
				if (text.startsWith('SELECT')) {
					const queryEmb = String(params?.[0] ?? '').replace(/^\[|\]$/g, '').split(',').map(Number);
					const cosine = (a: number[], b: number[]) => {
						let dot = 0, na = 0, nb = 0;
						for (let i = 0; i < a.length; i++) {
							dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!;
						}
						const denom = Math.sqrt(na) * Math.sqrt(nb);
						return denom === 0 ? 0 : dot / denom;
					};
					const scored = Array.from(rows.values()).map((r) => ({
						id: r.id, text: r.text, metadata: r.metadata, distance: 1 - cosine(queryEmb, r.embedding),
					}));
					scored.sort((a, b) => a.distance - b.distance);
					return { rows: scored.slice(0, params?.[params.length - 1] as number) as T[] };
				}
				if (text.startsWith('DELETE')) {
					if (params?.[0] && Array.isArray(params[0])) {
						for (const id of params[0] as string[]) rows.delete(id);
					} else {
						rows.clear();
					}
					return { rows: [] as T[] };
				}
				return { rows: [] as T[] };
			},
		};
	}

	it('schema, upsert, ANN query, delete round-trip works through the mock', async () => {
		const client = mockPg();
		const store = new PgvectorStore({ client, dimensions: 2 });
		await store.upsert([
			{ id: 'a', embedding: [1, 0], text: 'apple', metadata: { topic: 'fruit' } },
			{ id: 'b', embedding: [0, 1], text: 'beach', metadata: { topic: 'place' } },
		]);
		expect(client.queries.some((q) => q.text.startsWith('CREATE EXTENSION'))).toBe(true);
		expect(client.queries.some((q) => q.text.startsWith('CREATE TABLE'))).toBe(true);
		const matches = await store.query({ embedding: [1, 0], limit: 1 });
		expect(matches).toHaveLength(1);
		expect(matches[0]!.id).toBe('a');
		await store.delete(['a']);
		expect(client.rows.has('a')).toBe(false);
	});

	it('filter is applied via JSONB containment', async () => {
		const client = mockPg();
		const store = new PgvectorStore({ client, dimensions: 2 });
		await store.upsert([{ id: 'a', embedding: [1, 0], text: 'A', metadata: { userId: 'u1' } }]);
		await store.query({ embedding: [1, 0], filter: { userId: 'u1' } });
		const select = client.queries.find((q) => q.text.startsWith('SELECT'));
		expect(select?.text).toContain('metadata @>');
	});
});

describe('vectorstores: LibSqlVectorStore (mock libSQL client)', () => {
	function mockLibsql() {
		const rows = new Map<
			string,
			{ id: string; text: string; embedding: number[]; metadata: Record<string, unknown> | null }
		>();
		const log: Array<{ sql: string; args?: unknown[] }> = [];
		const cosine = (a: number[], b: number[]) => {
			let dot = 0, na = 0, nb = 0;
			for (let i = 0; i < a.length; i++) {
				dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!;
			}
			const denom = Math.sqrt(na) * Math.sqrt(nb);
			return denom === 0 ? 1 : 1 - dot / denom; // distance in [0, 2]
		};
		const parseVec = (s: string): number[] =>
			s.replace(/^\[|\]$/g, '').split(',').map((x) => Number(x));

		async function execOne(input: string | { sql: string; args?: unknown[] }) {
			const sql = typeof input === 'string' ? input : input.sql;
			const args = typeof input === 'string' ? [] : (input.args as unknown[] | undefined) ?? [];
			log.push({ sql, args });
			if (/^CREATE TABLE/i.test(sql)) {
				return { columns: [], rows: [], rowsAffected: 0 };
			}
			if (/^INSERT INTO/i.test(sql)) {
				const [id, text, vecStr, mdStr] = args;
				rows.set(String(id), {
					id: String(id),
					text: String(text),
					embedding: parseVec(String(vecStr)),
					metadata: mdStr ? (JSON.parse(String(mdStr)) as Record<string, unknown>) : null,
				});
				return { columns: [], rows: [], rowsAffected: 1 };
			}
			if (/^DELETE FROM .* WHERE id IN/i.test(sql)) {
				for (const id of args) rows.delete(String(id));
				return { columns: [], rows: [], rowsAffected: args.length };
			}
			if (/^DELETE FROM/i.test(sql)) {
				const n = rows.size;
				rows.clear();
				return { columns: [], rows: [], rowsAffected: n };
			}
			if (/^SELECT/i.test(sql)) {
				const queryVec = parseVec(String(args[0]));
				const limit = Number(args[args.length - 1]);
				const scored = Array.from(rows.values()).map((r) => ({
					id: r.id,
					text: r.text,
					metadata: r.metadata ? JSON.stringify(r.metadata) : null,
					distance: cosine(queryVec, r.embedding),
				}));
				scored.sort((a, b) => a.distance - b.distance);
				return { columns: ['id', 'text', 'metadata', 'distance'], rows: scored.slice(0, limit), rowsAffected: 0 };
			}
			return { columns: [], rows: [], rowsAffected: 0 };
		}

		return {
			rows,
			log,
			async execute(input: string | { sql: string; args?: unknown[] }) {
				return execOne(input);
			},
			async batch(stmts: Array<string | { sql: string; args?: unknown[] }>) {
				const out = [];
				for (const s of stmts) out.push(await execOne(s));
				return out;
			},
		};
	}

	it('schema CREATE uses F32_BLOB({dimensions})', async () => {
		const client = mockLibsql();
		const store = new LibSqlVectorStore({ client, dimensions: 8 });
		await store.upsert([{ id: 'a', embedding: [1, 0, 0, 0, 0, 0, 0, 0], text: 'A' }]);
		const create = client.log.find((q) => /^CREATE TABLE/i.test(q.sql));
		expect(create?.sql).toContain('F32_BLOB(8)');
	});

	it('upsert uses vector32(?) constructor', async () => {
		const client = mockLibsql();
		const store = new LibSqlVectorStore({ client, dimensions: 2 });
		await store.upsert([{ id: 'a', embedding: [1, 0], text: 'A' }]);
		const insert = client.log.find((q) => /^INSERT INTO/i.test(q.sql));
		expect(insert?.sql).toContain('vector32(?)');
	});

	it('query uses vector_distance_cos with ORDER BY ASC', async () => {
		const client = mockLibsql();
		const store = new LibSqlVectorStore({ client, dimensions: 2 });
		await store.upsert([
			{ id: 'a', embedding: [1, 0], text: 'A' },
			{ id: 'b', embedding: [0, 1], text: 'B' },
		]);
		const matches = await store.query({ embedding: [1, 0], limit: 1 });
		const select = client.log.find((q) => /^SELECT/i.test(q.sql));
		expect(select?.sql).toContain('vector_distance_cos');
		expect(select?.sql).toContain('ORDER BY distance ASC');
		expect(matches).toHaveLength(1);
		expect(matches[0]!.id).toBe('a');
		expect(matches[0]!.score).toBeCloseTo(1, 5);
	});

	it('honors metadata filter (post-fetch JS filter)', async () => {
		const client = mockLibsql();
		const store = new LibSqlVectorStore({ client, dimensions: 2 });
		await store.upsert([
			{ id: 'a', embedding: [1, 0], text: 'A', metadata: { userId: 'u1' } },
			{ id: 'b', embedding: [1, 0], text: 'B', metadata: { userId: 'u2' } },
		]);
		const matches = await store.query({ embedding: [1, 0], filter: { userId: 'u2' }, limit: 5 });
		expect(matches.map((m) => m.id)).toEqual(['b']);
	});

	it('upsert by same id replaces (ON CONFLICT UPDATE)', async () => {
		const client = mockLibsql();
		const store = new LibSqlVectorStore({ client, dimensions: 2 });
		await store.upsert([{ id: 'x', embedding: [1, 0], text: 'first' }]);
		await store.upsert([{ id: 'x', embedding: [0, 1], text: 'second' }]);
		expect(client.rows.size).toBe(1);
		expect(client.rows.get('x')?.text).toBe('second');
	});

	it('rejects wrong dimensions', async () => {
		const client = mockLibsql();
		const store = new LibSqlVectorStore({ client, dimensions: 4 });
		await expect(
			store.upsert([{ id: 'a', embedding: [1, 0], text: '' }]),
		).rejects.toThrow(/dimensions/);
	});

	it('delete + clear', async () => {
		const client = mockLibsql();
		const store = new LibSqlVectorStore({ client, dimensions: 2 });
		await store.upsert([
			{ id: 'a', embedding: [1, 0], text: '' },
			{ id: 'b', embedding: [0, 1], text: '' },
		]);
		await store.delete(['a']);
		expect(client.rows.has('a')).toBe(false);
		expect(client.rows.has('b')).toBe(true);
		await store.clear();
		expect(client.rows.size).toBe(0);
	});
});
