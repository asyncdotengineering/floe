import { describe, expect, it } from 'vitest';
import { RedisVectorStore } from '../src/vectorstores/redis.ts';
import { LanceDbVectorStore } from '../src/vectorstores/lancedb.ts';

describe('RedisVectorStore (mock client)', () => {
	function mockClient() {
		const hashes = new Map<string, Map<string, string | Uint8Array>>();
		const log: Array<{ cmd: string; args: Array<string | Uint8Array> }> = [];
		let indexExists = false;
		const parseVec = (v: string | Uint8Array): number[] => {
			const bytes = typeof v === 'string' ? new TextEncoder().encode(v) : v;
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			const out: number[] = [];
			for (let i = 0; i < bytes.byteLength; i += 4) {
				out.push(view.getFloat32(i, true));
			}
			return out;
		};
		const cosine = (a: number[], b: number[]) => {
			let dot = 0, na = 0, nb = 0;
			for (let i = 0; i < a.length; i++) {
				dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!;
			}
			const denom = Math.sqrt(na) * Math.sqrt(nb);
			return denom === 0 ? 1 : 1 - dot / denom; // distance ∈ [0, 2]
		};
		return {
			hashes,
			log,
			async command(args: Array<string | Uint8Array>) {
				const cmd = String(args[0]);
				log.push({ cmd, args });
				if (cmd === 'FT.CREATE') {
					if (indexExists) throw new Error('Index name already exists');
					indexExists = true;
					return 'OK';
				}
				if (cmd === 'FT.DROPINDEX') {
					indexExists = false;
					return 'OK';
				}
				if (cmd === 'HSET') {
					const key = String(args[1]);
					const h = hashes.get(key) ?? new Map<string, string | Uint8Array>();
					for (let i = 2; i < args.length; i += 2) {
						h.set(String(args[i]), args[i + 1]!);
					}
					hashes.set(key, h);
					return 'OK';
				}
				if (cmd === 'DEL') {
					hashes.delete(String(args[1]));
					return 1;
				}
				if (cmd === 'FT.SEARCH') {
					// Find the query vector blob: PARAMS 2 blob <blob>
					const paramsIdx = args.indexOf('PARAMS');
					const queryVec = parseVec(args[paramsIdx + 3] as string | Uint8Array);
					const limitIdx = args.indexOf('LIMIT');
					const fetchLimit = Number(args[limitIdx + 2] ?? '10');
					// Score every stored doc and sort by ascending distance.
					const scored: Array<{ key: string; distance: number; text: string; metadata: string }> = [];
					for (const [key, fields] of hashes) {
						const emb = fields.get('embedding');
						if (!emb) continue;
						const v = parseVec(emb);
						const distance = cosine(queryVec, v);
						scored.push({
							key,
							distance,
							text: String(fields.get('text') ?? ''),
							metadata: String(fields.get('metadata') ?? '{}'),
						});
					}
					scored.sort((a, b) => a.distance - b.distance);
					const top = scored.slice(0, fetchLimit);
					const reply: Array<string | Array<string>> = [String(top.length)];
					for (const t of top) {
						reply.push(t.key);
						reply.push(['__score', String(t.distance), 'text', t.text, 'metadata', t.metadata]);
					}
					return reply;
				}
				return null;
			},
		};
	}

	it('upsert → query returns matches sorted by cosine similarity', async () => {
		const client = mockClient();
		const store = new RedisVectorStore({ client, dimensions: 2 });
		await store.upsert([
			{ id: 'a', embedding: [1, 0], text: 'apple' },
			{ id: 'b', embedding: [0.9, 0.1], text: 'apricot' },
			{ id: 'c', embedding: [0, 1], text: 'cinema' },
		]);
		const matches = await store.query({ embedding: [1, 0], limit: 2 });
		expect(matches).toHaveLength(2);
		expect(matches[0]!.id).toBe('a');
		expect(matches[1]!.id).toBe('b');
		expect(matches[0]!.score).toBeGreaterThan(matches[1]!.score);
	});

	it('emits FT.CREATE on first use, tolerates "already exists" thereafter', async () => {
		const client = mockClient();
		const store = new RedisVectorStore({ client, dimensions: 2 });
		await store.upsert([{ id: 'a', embedding: [1, 0], text: 'A' }]);
		const createCalls = client.log.filter((c) => c.cmd === 'FT.CREATE');
		expect(createCalls).toHaveLength(1);
		// Re-create should NOT throw (the mock raises "already exists"; the store swallows it).
		const store2 = new RedisVectorStore({ client, dimensions: 2 });
		await expect(store2.upsert([{ id: 'b', embedding: [0, 1], text: 'B' }])).resolves.toBeUndefined();
	});

	it('FT.CREATE includes COSINE distance + correct dim', async () => {
		const client = mockClient();
		const store = new RedisVectorStore({ client, dimensions: 8 });
		await store.upsert([{ id: 'a', embedding: new Array(8).fill(0).map((_, i) => i), text: 'A' }]);
		const create = client.log.find((c) => c.cmd === 'FT.CREATE');
		const args = create!.args.map((a) => (a instanceof Uint8Array ? '<bytes>' : a));
		expect(args).toContain('DIM');
		expect(args).toContain('8');
		expect(args).toContain('DISTANCE_METRIC');
		expect(args).toContain('COSINE');
	});

	it('respects metadata filter (post-fetch)', async () => {
		const client = mockClient();
		const store = new RedisVectorStore({ client, dimensions: 2 });
		await store.upsert([
			{ id: 'u1', embedding: [1, 0], text: 'A', metadata: { userId: 'u1' } },
			{ id: 'u2', embedding: [1, 0], text: 'B', metadata: { userId: 'u2' } },
		]);
		const matches = await store.query({ embedding: [1, 0], filter: { userId: 'u2' } });
		expect(matches.map((m) => m.id)).toEqual(['u2']);
	});

	it('rejects wrong dimensions on upsert', async () => {
		const client = mockClient();
		const store = new RedisVectorStore({ client, dimensions: 4 });
		await expect(
			store.upsert([{ id: 'a', embedding: [1, 0], text: '' }]),
		).rejects.toThrow(/dimensions/);
	});

	it('delete removes the hash', async () => {
		const client = mockClient();
		const store = new RedisVectorStore({ client, dimensions: 2 });
		await store.upsert([{ id: 'a', embedding: [1, 0], text: 'A' }]);
		expect(client.hashes.has('floe:vec:a')).toBe(true);
		await store.delete(['a']);
		expect(client.hashes.has('floe:vec:a')).toBe(false);
	});

	it('clear drops the index with DD', async () => {
		const client = mockClient();
		const store = new RedisVectorStore({ client, dimensions: 2 });
		await store.upsert([{ id: 'a', embedding: [1, 0], text: 'A' }]);
		await store.clear();
		const drop = client.log.find((c) => c.cmd === 'FT.DROPINDEX');
		expect(drop).toBeDefined();
		expect(drop!.args.map(String)).toContain('DD');
	});

	it('encodes embedding as little-endian Float32 bytes', async () => {
		const client = mockClient();
		const store = new RedisVectorStore({ client, dimensions: 1 });
		await store.upsert([{ id: 'x', embedding: [1.5], text: '' }]);
		const hset = client.log.find((c) => c.cmd === 'HSET');
		const idx = hset!.args.indexOf('embedding');
		const blob = hset!.args[idx + 1];
		expect(blob).toBeInstanceOf(Uint8Array);
		expect((blob as Uint8Array).byteLength).toBe(4);
		const view = new DataView((blob as Uint8Array).buffer);
		expect(view.getFloat32(0, true)).toBe(1.5);
	});
});

describe('LanceDbVectorStore (mock table)', () => {
	function mockTable() {
		const rows = new Map<string, { id: string; vector: number[]; text: string; metadata: string }>();
		const mergeLog: Array<Record<string, unknown>[]> = [];
		const deleteLog: string[] = [];
		const cosine = (a: number[], b: number[]) => {
			let dot = 0, na = 0, nb = 0;
			for (let i = 0; i < a.length; i++) {
				dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!;
			}
			const denom = Math.sqrt(na) * Math.sqrt(nb);
			return denom === 0 ? 1 : 1 - dot / denom; // cosine distance ∈ [0, 2]
		};

		const buildSearch = (queryVec: number[]) => {
			let limitN = 10;
			let predicate: string | undefined;
			let metric: 'cosine' | 'l2' | 'dot' = 'cosine';
			const api: ReturnType<typeof mockTable>['searchApi'] = {
				limit(n) { limitN = n; return api; },
				where(p) { predicate = p; return api; },
				distanceType(m) { metric = m; return api; },
				async toArray() {
					const all = Array.from(rows.values()).map((r) => ({
						id: r.id,
						vector: r.vector,
						text: r.text,
						metadata: r.metadata,
						_distance: cosine(queryVec, r.vector),
					}));
					all.sort((a, b) => a._distance - b._distance);
					// predicate is a no-op for the mock — JS-side filter in the store handles it
					void predicate; void metric;
					return all.slice(0, limitN) as unknown as Array<Record<string, unknown>>;
				},
			};
			return api;
		};

		return {
			rows,
			mergeLog,
			deleteLog,
			searchApi: undefined as unknown as {
				limit(n: number): unknown;
				where(p: string): unknown;
				distanceType(m: 'cosine' | 'l2' | 'dot'): unknown;
				toArray(): Promise<Array<Record<string, unknown>>>;
			},
			async add(records: Array<Record<string, unknown>>) {
				for (const r of records) {
					rows.set(String(r.id), {
						id: String(r.id),
						vector: r.vector as number[],
						text: String(r.text),
						metadata: String(r.metadata ?? '{}'),
					});
				}
			},
			async delete(predicate: string) {
				deleteLog.push(predicate);
				if (predicate === 'true') {
					rows.clear();
					return;
				}
				// crude IN-clause parser: id IN ('a','b')
				const inMatch = predicate.match(/id IN \(([^)]+)\)/i);
				if (inMatch) {
					const ids = (inMatch[1] ?? '').split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
					for (const id of ids) rows.delete(id);
				}
			},
			search(vector: number[]) {
				return buildSearch(vector);
			},
			mergeInsert(_on: string) {
				return {
					whenMatchedUpdateAll() {
						return {
							whenNotMatchedInsertAll() {
								return {
									async execute(records: Array<Record<string, unknown>>) {
										mergeLog.push(records);
										for (const r of records) {
											rows.set(String(r.id), {
												id: String(r.id),
												vector: r.vector as number[],
												text: String(r.text),
												metadata: String(r.metadata ?? '{}'),
											});
										}
									},
								};
							},
						};
					},
				};
			},
		};
	}

	it('upsert via mergeInsert when available', async () => {
		const table = mockTable();
		const store = new LanceDbVectorStore({ table, dimensions: 2 });
		await store.upsert([{ id: 'a', embedding: [1, 0], text: 'A' }]);
		expect(table.mergeLog).toHaveLength(1);
	});

	it('upsert + cosine search returns nearest first', async () => {
		const table = mockTable();
		const store = new LanceDbVectorStore({ table, dimensions: 2 });
		await store.upsert([
			{ id: 'a', embedding: [1, 0], text: 'apple' },
			{ id: 'b', embedding: [0.5, 0.5], text: 'bee' },
			{ id: 'c', embedding: [0, 1], text: 'cinema' },
		]);
		const matches = await store.query({ embedding: [1, 0], limit: 2 });
		expect(matches.map((m) => m.id)).toEqual(['a', 'b']);
		expect(matches[0]!.score).toBeGreaterThan(matches[1]!.score);
	});

	it('falls back to delete+add when mergeInsert disabled', async () => {
		const table = mockTable();
		const store = new LanceDbVectorStore({ table, dimensions: 2, useMergeInsert: false });
		await store.upsert([{ id: 'a', embedding: [1, 0], text: 'A' }]);
		// First call uses fallback path which DELETES the row first (the row doesn't exist yet → no-op).
		expect(table.deleteLog.length).toBeGreaterThanOrEqual(1);
		expect(table.rows.has('a')).toBe(true);
	});

	it('honors metadata filter post-fetch', async () => {
		const table = mockTable();
		const store = new LanceDbVectorStore({ table, dimensions: 2 });
		await store.upsert([
			{ id: 'u1', embedding: [1, 0], text: 'A', metadata: { userId: 'u1' } },
			{ id: 'u2', embedding: [1, 0], text: 'B', metadata: { userId: 'u2' } },
		]);
		const matches = await store.query({ embedding: [1, 0], filter: { userId: 'u2' } });
		expect(matches.map((m) => m.id)).toEqual(['u2']);
	});

	it('rejects wrong dimensions', async () => {
		const table = mockTable();
		const store = new LanceDbVectorStore({ table, dimensions: 4 });
		await expect(
			store.upsert([{ id: 'a', embedding: [1, 0], text: '' }]),
		).rejects.toThrow(/dimensions/);
	});

	it('delete builds an IN-clause predicate', async () => {
		const table = mockTable();
		const store = new LanceDbVectorStore({ table, dimensions: 2 });
		await store.upsert([
			{ id: 'a', embedding: [1, 0], text: '' },
			{ id: 'b', embedding: [0, 1], text: '' },
		]);
		await store.delete(['a']);
		const lastDelete = table.deleteLog[table.deleteLog.length - 1]!;
		expect(lastDelete).toContain("'a'");
		expect(table.rows.has('a')).toBe(false);
		expect(table.rows.has('b')).toBe(true);
	});

	it('clear deletes all with predicate "true"', async () => {
		const table = mockTable();
		const store = new LanceDbVectorStore({ table, dimensions: 2 });
		await store.upsert([{ id: 'a', embedding: [1, 0], text: '' }]);
		await store.clear();
		expect(table.rows.size).toBe(0);
	});

	it('cosine distance normalizes to similarity ∈ [0,1]', async () => {
		const table = mockTable();
		const store = new LanceDbVectorStore({ table, dimensions: 2 });
		await store.upsert([
			{ id: 'identical', embedding: [1, 0], text: '' },
			{ id: 'opposite', embedding: [-1, 0], text: '' },
		]);
		const matches = await store.query({ embedding: [1, 0], limit: 2 });
		expect(matches[0]!.score).toBeGreaterThan(0.99);
		expect(matches[1]!.score).toBeLessThan(0.01);
	});

	it('escapes single quotes in ids for SQL safety', async () => {
		const table = mockTable();
		const store = new LanceDbVectorStore({ table, dimensions: 2, useMergeInsert: false });
		await store.upsert([{ id: "evil'id", embedding: [1, 0], text: '' }]);
		const lastDelete = table.deleteLog[table.deleteLog.length - 1] ?? '';
		expect(lastDelete).toContain("'evil''id'");
	});
});
