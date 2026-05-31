import { describe, expect, it } from 'vitest';
import { VectorStoreMemoryService } from '../src/memory/vector-store-service.ts';
import { FakeEmbedder } from '../src/embedders/fake.ts';
import { InMemoryVectorStore } from '../src/vectorstores/in-memory.ts';
import { DEFAULT_MEMORY_NAMESPACE } from '../src/memory/types.ts';

describe('Hierarchical memory namespaces', () => {
	function build() {
		const store = new InMemoryVectorStore({ dimensions: 16 });
		const svc = new VectorStoreMemoryService({
			embedder: new FakeEmbedder({ dimensions: 16 }),
			vectorStore: store,
		});
		return { svc, store };
	}

	it('ingestTurn defaults to "default" namespace when none specified', async () => {
		const { svc, store } = build();
		await svc.ingestTurn({
			sessionId: 's1',
			userId: 'alice',
			userMessage: 'I prefer email',
		});
		const items = await store.query({ embedding: new Array(16).fill(0).map((_, i) => i === 0 ? 1 : 0), limit: 10 });
		// Item present
		expect(items.length).toBeGreaterThan(0);
		// Metadata has namespace=default
		const hasDefault = items.some((i) => i.metadata?.namespace === DEFAULT_MEMORY_NAMESPACE);
		expect(hasDefault).toBe(true);
	});

	it('ingestTurn honors explicit namespace', async () => {
		const { svc } = build();
		await svc.ingestTurn({
			sessionId: 's1',
			userId: 'alice',
			namespace: 'preferences',
			userMessage: 'I prefer email contact',
		});
		const hits = await svc.search({
			userId: 'alice',
			query: 'email preference',
			namespace: 'preferences',
		});
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]!.namespace).toBe('preferences');
	});

	it('search with namespace filter excludes other namespaces', async () => {
		const { svc } = build();
		await svc.ingestTurn({
			sessionId: 's1',
			userId: 'alice',
			namespace: 'preferences',
			userMessage: 'I prefer email contact',
		});
		await svc.ingestTurn({
			sessionId: 's2',
			userId: 'alice',
			namespace: 'billing',
			userMessage: 'Visa card ending 4242 on file',
		});
		const prefs = await svc.search({
			userId: 'alice',
			query: 'email card preference',
			namespace: 'preferences',
		});
		expect(prefs.every((p) => p.namespace === 'preferences')).toBe(true);
		const billing = await svc.search({
			userId: 'alice',
			query: 'email card preference',
			namespace: 'billing',
		});
		expect(billing.every((p) => p.namespace === 'billing')).toBe(true);
		expect(prefs[0]!.content).toContain('email');
		expect(billing[0]!.content).toContain('Visa');
	});

	it('search without namespace returns all', async () => {
		const { svc } = build();
		await svc.ingestTurn({ sessionId: 's', userId: 'alice', namespace: 'a', userMessage: 'preference apple' });
		await svc.ingestTurn({ sessionId: 's', userId: 'alice', namespace: 'b', userMessage: 'preference banana' });
		const both = await svc.search({ userId: 'alice', query: 'preference apple banana' });
		expect(both.length).toBeGreaterThanOrEqual(2);
		const namespaces = new Set(both.map((h) => h.namespace));
		expect(namespaces.size).toBeGreaterThanOrEqual(2);
	});

	it('ingestSession namespace flows through to entries', async () => {
		const { svc } = build();
		await svc.ingestSession({
			sessionId: 's',
			userId: 'alice',
			namespace: 'preferences',
			messages: [
				{ role: 'user', content: 'I prefer email' },
				{ role: 'assistant', content: 'Noted.' },
			],
		});
		const hits = await svc.search({ userId: 'alice', query: 'email preference', namespace: 'preferences' });
		expect(hits.length).toBeGreaterThan(0);
	});
});
