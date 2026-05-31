/**
 * Pre-LLM product knowledge source backed by the SQLite catalog +
 * embedding index. Plugs into Floe's `knowledge: [...]` array — runs
 * BEFORE the LLM call, injects ranked products into the system prompt
 * as reference material. Zero extra LLM hops; voice-safe.
 *
 * Different from the markdown HybridKnowledgeSource because the source
 * of truth is a DB row, not a chunked file. We render each top product
 * as a structured fact card the model can cite verbatim.
 */
import { defineKnowledgeSource } from '@floe/runtime';
import type { CatalogHandle } from './catalog.ts';

export function productCatalogKnowledge(opts: {
	catalog: CatalogHandle;
	name?: string;
	limit?: number;
}) {
	const name = opts.name ?? 'product-catalog';
	const limit = opts.limit ?? 5;
	let prepared = false;

	return defineKnowledgeSource({
		name,
		async prepare(): Promise<void> {
			if (prepared) return;
			prepared = true;
			await opts.catalog.indexEmbeddings();
		},
		async search(query) {
			if (!query.trim()) return [];
			// Lazy-index on first search (in case prepare() was bypassed).
			await opts.catalog.indexEmbeddings();
			const hits = await opts.catalog.hybridSearch({ query, limit });
			return hits.map((p) => {
				const totalStock = Object.values(p.stockBySize).reduce((a, b) => a + b, 0);
				const stockSummary = Object.entries(p.stockBySize)
					.map(([size, count]) => `${size}: ${count}`)
					.join(', ');
				const text = [
					`PRODUCT: ${p.name}  (SKU: ${p.sku})`,
					`Category: ${p.category}  ·  Price: $${p.priceUsd}`,
					`Sizes: ${p.sizesAvailable.join(', ')}  ·  Colors: ${p.colorsAvailable.join(', ')}`,
					`Stock: ${totalStock} total  (${stockSummary})`,
					``,
					p.description,
					``,
					`Tags: ${p.tags.join(', ')}`,
				].join('\n');
				return {
					id: p.sku,
					text,
					source: 'catalog',
					score: p.score,
					metadata: { sku: p.sku, name: p.name, priceUsd: p.priceUsd, category: p.category },
				};
			});
		},
	});
}
