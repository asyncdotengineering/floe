import { describe, expect, it } from 'vitest';
import {
	InMemoryMemoryService,
	preloadMemoryContext,
} from '../src/memory/index.ts';

describe('memory: InMemoryMemoryService', () => {
	it('ingestTurn stores user + assistant content', async () => {
		const svc = new InMemoryMemoryService();
		await svc.ingestTurn({
			sessionId: 'sess-1',
			userId: 'user-a',
			userMessage: 'I prefer email over phone',
			assistantText: 'Noted — I will email you next time.',
		});
		const hits = await svc.search({ userId: 'user-a', query: 'email preference' });
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]!.content.toLowerCase()).toContain('email');
	});

	it('isolates by userId', async () => {
		const svc = new InMemoryMemoryService();
		await svc.ingestTurn({ sessionId: 's1', userId: 'a', userMessage: 'I like cats' });
		await svc.ingestTurn({ sessionId: 's2', userId: 'b', userMessage: 'I like dogs' });
		expect((await svc.search({ userId: 'a', query: 'cats' }))).toHaveLength(1);
		expect((await svc.search({ userId: 'b', query: 'cats' }))).toHaveLength(0);
		expect((await svc.search({ userId: 'b', query: 'dogs' }))).toHaveLength(1);
	});

	it('ingestSession is idempotent — re-ingesting replaces prior entries from the session', async () => {
		const svc = new InMemoryMemoryService();
		await svc.ingestSession({
			sessionId: 's1',
			userId: 'a',
			messages: [
				{ role: 'user', content: 'first run hello' },
				{ role: 'assistant', content: 'first run hi back' },
			],
		});
		await svc.ingestSession({
			sessionId: 's1',
			userId: 'a',
			messages: [{ role: 'user', content: 'second run hello' }],
		});
		const all = await svc.search({ userId: 'a', query: 'hello' });
		// Second run should have replaced the first — 'first run' content gone.
		expect(all.find((e) => e.content.includes('first run'))).toBeUndefined();
		expect(all.find((e) => e.content.includes('second run'))).toBeDefined();
	});

	it('BM25 ranks more-relevant entries first', async () => {
		const svc = new InMemoryMemoryService();
		await svc.ingestTurn({ sessionId: 's', userId: 'a', userMessage: 'I work at Acme as a billing manager' });
		await svc.ingestTurn({ sessionId: 's', userId: 'a', userMessage: 'My favorite color is blue' });
		const hits = await svc.search({ userId: 'a', query: 'billing role' });
		expect(hits[0]!.content).toContain('billing');
		expect(hits[0]!.score).toBeCloseTo(1.0, 5);
	});

	it('search returns empty for missing users', async () => {
		const svc = new InMemoryMemoryService();
		expect(await svc.search({ userId: 'nobody', query: 'anything' })).toEqual([]);
	});

	it('deleteForUser removes all entries', async () => {
		const svc = new InMemoryMemoryService();
		await svc.ingestTurn({ sessionId: 's', userId: 'a', userMessage: 'remember me' });
		await svc.deleteForUser?.('a');
		expect(await svc.search({ userId: 'a', query: 'remember' })).toEqual([]);
	});

	it('respects metadata filter', async () => {
		const svc = new InMemoryMemoryService();
		await svc.ingestTurn({
			sessionId: 's1', userId: 'a', userMessage: 'billing question one',
			metadata: { topic: 'billing' },
		});
		await svc.ingestTurn({
			sessionId: 's2', userId: 'a', userMessage: 'billing question two',
			metadata: { topic: 'shipping' },
		});
		const onlyBilling = await svc.search({
			userId: 'a', query: 'billing', filter: { topic: 'billing' },
		});
		expect(onlyBilling.length).toBe(1);
		expect(onlyBilling[0]!.metadata?.topic).toBe('billing');
	});
});

describe('memory: preloadMemoryContext', () => {
	it('returns null when there are no memories', async () => {
		const svc = new InMemoryMemoryService();
		const out = await preloadMemoryContext({
			service: svc,
			userId: 'a',
			userInput: 'something',
		});
		expect(out).toBeNull();
	});

	it('builds a markdown header + bullet lines with most-recent date', async () => {
		const svc = new InMemoryMemoryService();
		await svc.ingestTurn({
			sessionId: 's1',
			userId: 'a',
			userMessage: 'I prefer email contact',
		});
		const out = await preloadMemoryContext({
			service: svc,
			userId: 'a',
			userInput: 'email preference',
			maxTokens: 800,
		});
		expect(out).not.toBeNull();
		expect(out).toContain('## Context from Past Conversations');
		expect(out).toContain('email');
	});

	it('hard-caps output at the token budget', async () => {
		const svc = new InMemoryMemoryService();
		// Ingest 20 entries of similar relevance.
		for (let i = 0; i < 20; i++) {
			await svc.ingestTurn({
				sessionId: 's' + i,
				userId: 'a',
				userMessage: `billing detail number ${i} with some additional padding text here to make it longer than a few tokens`,
			});
		}
		const small = await preloadMemoryContext({
			service: svc,
			userId: 'a',
			userInput: 'billing',
			maxTokens: 250, // enough for header + ~1 entry
		});
		const big = await preloadMemoryContext({
			service: svc,
			userId: 'a',
			userInput: 'billing',
			maxTokens: 4000, // enough for many entries
		});
		expect(small).not.toBeNull();
		expect(big).not.toBeNull();
		// Smaller budget produces shorter output (fewer entries fit).
		expect(small!.length).toBeLessThan(big!.length);
	});

	it('returns null when userInput tokenizes to nothing', async () => {
		const svc = new InMemoryMemoryService();
		await svc.ingestTurn({ sessionId: 's', userId: 'a', userMessage: 'something real' });
		const out = await preloadMemoryContext({
			service: svc,
			userId: 'a',
			userInput: 'a the of',
		});
		expect(out).toBeNull();
	});
});
