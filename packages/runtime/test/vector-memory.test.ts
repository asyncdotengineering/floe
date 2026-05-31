import { describe, expect, it } from 'vitest';
import { VectorStoreMemoryService } from '../src/memory/vector-store-service.ts';
import { FakeEmbedder } from '../src/embedders/fake.ts';
import { InMemoryVectorStore } from '../src/vectorstores/in-memory.ts';

describe('VectorStoreMemoryService', () => {
	it('throws on dimension mismatch', () => {
		expect(
			() =>
				new VectorStoreMemoryService({
					embedder: new FakeEmbedder({ dimensions: 8 }),
					vectorStore: new InMemoryVectorStore({ dimensions: 16 }),
				}),
		).toThrow(/dimensions/);
	});

	it('ingestTurn stores user + assistant content with userId metadata', async () => {
		const embedder = new FakeEmbedder({ dimensions: 32 });
		const store = new InMemoryVectorStore({ dimensions: 32 });
		const svc = new VectorStoreMemoryService({ embedder, vectorStore: store });
		await svc.ingestTurn({
			sessionId: 'sess-1',
			userId: 'alice',
			userMessage: 'I prefer email contact',
			assistantText: 'Noted; I will email you next time.',
		});
		expect(store.size()).toBe(2);
	});

	it('search filters by userId — bob cannot see alice', async () => {
		const embedder = new FakeEmbedder({ dimensions: 32 });
		const store = new InMemoryVectorStore({ dimensions: 32 });
		const svc = new VectorStoreMemoryService({ embedder, vectorStore: store });
		await svc.ingestTurn({
			sessionId: 'sess-a',
			userId: 'alice',
			userMessage: 'My favourite color is blue',
		});
		await svc.ingestTurn({
			sessionId: 'sess-b',
			userId: 'bob',
			userMessage: 'My favourite color is red',
		});
		const aliceHits = await svc.search({ userId: 'alice', query: 'favourite color' });
		const bobHits = await svc.search({ userId: 'bob', query: 'favourite color' });
		expect(aliceHits.length).toBeGreaterThan(0);
		expect(bobHits.length).toBeGreaterThan(0);
		expect(aliceHits.every((h) => h.userId === 'alice')).toBe(true);
		expect(bobHits.every((h) => h.userId === 'bob')).toBe(true);
		expect(aliceHits[0]!.content.toLowerCase()).toContain('blue');
		expect(bobHits[0]!.content.toLowerCase()).toContain('red');
	});

	it('search returns empty for unknown users', async () => {
		const svc = new VectorStoreMemoryService({
			embedder: new FakeEmbedder({ dimensions: 16 }),
			vectorStore: new InMemoryVectorStore({ dimensions: 16 }),
		});
		const hits = await svc.search({ userId: 'nobody', query: 'anything' });
		expect(hits).toEqual([]);
	});

	it('ingestSession is repeatable and additive (no idempotency on this adapter)', async () => {
		const store = new InMemoryVectorStore({ dimensions: 16 });
		const svc = new VectorStoreMemoryService({
			embedder: new FakeEmbedder({ dimensions: 16 }),
			vectorStore: store,
		});
		await svc.ingestSession({
			sessionId: 's', userId: 'a',
			messages: [{ role: 'user', content: 'hello world' }],
		});
		await svc.ingestSession({
			sessionId: 's', userId: 'a',
			messages: [{ role: 'user', content: 'goodbye world' }],
		});
		expect(store.size()).toBe(2);
	});

	it('search returns empty for empty query (no embed call wasted)', async () => {
		const svc = new VectorStoreMemoryService({
			embedder: new FakeEmbedder({ dimensions: 16 }),
			vectorStore: new InMemoryVectorStore({ dimensions: 16 }),
		});
		expect(await svc.search({ userId: 'a', query: '   ' })).toEqual([]);
	});
});
