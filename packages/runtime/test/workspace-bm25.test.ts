import { describe, expect, it } from 'vitest';
import { workspaceBm25 } from '../src/knowledge/workspace-bm25.ts';
import { mockSession } from './_helpers.ts';

describe('workspace-bm25', () => {
	it('regression: expands `<dir>/**/*.<ext>` glob', async () => {
		// This is the exact pattern that broke the live test before the
		// expandGlob fix — `knowledge/**/*.md` returned 0 files because the
		// matcher only handled `**/*.<ext>` with no dir prefix.
		const session = mockSession({
			files: {
				'knowledge/plans.md': '# Pro\nPro plan costs $89 per month with 15 seats.',
				'knowledge/billing.md': '# Billing\nWe accept cards and ACH.',
				'knowledge/nested/deep.md': '# Deep\nNested content about workflows.',
				'docs/unrelated.md': '# Other\nShould not be indexed.',
			},
		});
		const source = workspaceBm25({ paths: ['knowledge/**/*.md'], minChunkSize: 10 });
		await source.prepare(session);
		const hits = await source.search('pro plan pricing', { limit: 5 });
		expect(hits.length).toBeGreaterThan(0);
		const sources = hits.map((h) => h.source);
		expect(sources.some((s) => s.startsWith('knowledge/'))).toBe(true);
		expect(sources.some((s) => s.startsWith('docs/'))).toBe(false);
	});

	it('returns higher-scoring chunks first and normalizes top score to 1.0', async () => {
		const session = mockSession({
			files: {
				'docs/a.md': '# A\nPro plan costs $89 per month with 15 seats and advanced workflows.',
				'docs/b.md': '# B\nBilling cycle resets monthly. We accept cards.',
			},
		});
		const source = workspaceBm25({ paths: ['docs/**/*.md'], minChunkSize: 10 });
		await source.prepare(session);
		const hits = await source.search('pro plan seats workflows');
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]!.score).toBeCloseTo(1.0, 5);
		expect(hits[0]!.source).toBe('docs/a.md');
		if (hits.length > 1) {
			expect(hits[1]!.score).toBeLessThan(hits[0]!.score);
		}
	});

	it('returns empty array when no documents match', async () => {
		const session = mockSession({
			files: { 'docs/a.md': '# A\nBilling and payments and invoices.' },
		});
		const source = workspaceBm25({ paths: ['docs/**/*.md'], minChunkSize: 10 });
		await source.prepare(session);
		const hits = await source.search('quantum chromodynamics');
		expect(hits).toEqual([]);
	});

	it('applies stopword filtering — query of pure stopwords returns nothing', async () => {
		const session = mockSession({
			files: { 'docs/a.md': '# A\nBilling and payments and invoices.' },
		});
		const source = workspaceBm25({ paths: ['docs/**/*.md'], minChunkSize: 10 });
		await source.prepare(session);
		const hits = await source.search('the a is on at');
		expect(hits).toEqual([]);
	});

	it('respects custom limit', async () => {
		const session = mockSession({
			files: {
				'docs/a.md': '# A\npro plan',
				'docs/b.md': '# B\npro plan',
				'docs/c.md': '# C\npro plan',
				'docs/d.md': '# D\npro plan',
			},
		});
		const source = workspaceBm25({ paths: ['docs/**/*.md'], minChunkSize: 10 });
		await source.prepare(session);
		const hits = await source.search('pro plan', { limit: 2 });
		expect(hits.length).toBe(2);
	});

	it('handles `<dir>/*.<ext>` (non-recursive) glob', async () => {
		const session = mockSession({
			files: {
				'docs/a.md': '# A\npro plan',
				'docs/nested/b.md': '# B\npro plan (should be excluded)',
			},
		});
		const source = workspaceBm25({ paths: ['docs/*.md'], minChunkSize: 10 });
		await source.prepare(session);
		const hits = await source.search('pro plan');
		expect(hits.map((h) => h.source)).toEqual(['docs/a.md']);
	});
});
