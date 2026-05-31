import { describe, expect, it } from 'vitest';
import { hybridKnowledge } from '../src/knowledge/hybrid.ts';
import { FakeEmbedder } from '../src/embedders/fake.ts';
import { InMemoryVectorStore } from '../src/vectorstores/in-memory.ts';
import { mockSession } from './_helpers.ts';

describe('hybridKnowledge', () => {
	it('throws when embedder + vector store dimensions mismatch', () => {
		expect(() =>
			hybridKnowledge({
				paths: ['*.md'],
				embedder: new FakeEmbedder({ dimensions: 8 }),
				vectorStore: new InMemoryVectorStore({ dimensions: 16 }),
			}),
		).toThrow(/dimensions/);
	});

	it('indexes markdown, then returns ranked chunks for a query', async () => {
		const session = mockSession({
			files: {
				'knowledge/pricing.md': '# Pricing\n\nPro plan costs $89 per month with 15 seats. Annual billing receives 17% discount.',
				'knowledge/billing.md': '# Billing\n\nWe accept credit cards and ACH transfers. Payments process via Stripe.',
			},
		});
		const source = hybridKnowledge({
			paths: ['knowledge/**/*.md'],
			embedder: new FakeEmbedder({ dimensions: 64 }),
			vectorStore: new InMemoryVectorStore({ dimensions: 64 }),
			minChunkSize: 20,
			strongSignal: false,
		});
		await source.prepare(session);
		const hits = await source.search('pricing for the pro plan');
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]!.text.toLowerCase()).toContain('pro plan');
	});

	it('strong-signal bypass short-circuits the vector path', async () => {
		const session = mockSession({
			files: {
				'k/a.md': '# Pricing\n\nThe Pro plan costs ninety dollars monthly and has fifteen seats included.',
				'k/b.md': '# Refunds\n\nRefunds are issued within thirty days of purchase per our policy.',
			},
		});
		let embedCallCount = 0;
		class CountingEmbedder extends FakeEmbedder {
			async embed(texts: string[]) {
				embedCallCount++;
				return super.embed(texts);
			}
		}
		const embedder = new CountingEmbedder({ dimensions: 32 });
		const source = hybridKnowledge({
			paths: ['k/**/*.md'],
			embedder,
			vectorStore: new InMemoryVectorStore({ dimensions: 32 }),
			minChunkSize: 20,
			strongSignal: { minScore: 0.5, minGap: 0.1 }, // generous to force bypass
		});
		await source.prepare(session);
		const baselineEmbedCalls = embedCallCount;
		const hits = await source.search('pro plan pricing dollars monthly seats');
		expect(hits.length).toBeGreaterThan(0);
		// Strong signal should mean NO additional embed call for the query.
		expect(embedCallCount).toBe(baselineEmbedCalls);
	});

	it('without strong-signal, the vector path always runs', async () => {
		const session = mockSession({
			files: { 'k/a.md': '# A\n\nthe pro plan costs ninety dollars.' },
		});
		let embedCalls = 0;
		class CountingEmbedder extends FakeEmbedder {
			async embed(texts: string[]) {
				embedCalls++;
				return super.embed(texts);
			}
		}
		const embedder = new CountingEmbedder({ dimensions: 32 });
		const source = hybridKnowledge({
			paths: ['k/**/*.md'],
			embedder,
			vectorStore: new InMemoryVectorStore({ dimensions: 32 }),
			minChunkSize: 20,
			strongSignal: false,
		});
		await source.prepare(session);
		const baseline = embedCalls;
		await source.search('pro plan price');
		expect(embedCalls).toBeGreaterThan(baseline);
	});
});
