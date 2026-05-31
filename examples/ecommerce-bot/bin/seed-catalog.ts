#!/usr/bin/env tsx
/**
 * Pre-flight: seed the SQLite catalog AND index OpenAI embeddings for
 * every product. Runs once per environment to ensure the first bench
 * turn doesn't pay the cold-start cost.
 *
 * Idempotent: if the DB is already seeded and embeddings exist in
 * memory, this is a near no-op.
 *
 * Usage:
 *   OPENAI_API_KEY=... pnpm tsx bin/seed-catalog.ts
 */
import { openCatalog } from '../lib/catalog.ts';
import { openaiEmbedder } from '@floe/runtime/embedders/openai';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
	console.error('[seed-catalog] OPENAI_API_KEY required.');
	process.exit(1);
}

const embedder = openaiEmbedder({
	apiKey,
	model: 'text-embedding-3-small',
	dimensions: 256,
});

console.error('[seed-catalog] opening catalog (creates DB + seeds rows if empty)...');
const t0 = Date.now();
const catalog = await openCatalog(embedder);
const openMs = Date.now() - t0;
const products = await catalog.listProducts();
console.error(`[seed-catalog] ${products.length} product row(s) in DB (${openMs}ms)`);

console.error('[seed-catalog] embedding product descriptions (one OpenAI batch call)...');
const t1 = Date.now();
await catalog.indexEmbeddings();
const embedMs = Date.now() - t1;
console.error(`[seed-catalog] embeddings indexed in ${embedMs}ms`);

// Smoke-test hybrid search end-to-end.
console.error('[seed-catalog] smoke-test: hybridSearch("warm jacket for winter")...');
const t2 = Date.now();
const hits = await catalog.hybridSearch({ query: 'warm jacket for winter', limit: 3 });
const searchMs = Date.now() - t2;
console.error(`[seed-catalog] returned ${hits.length} hit(s) in ${searchMs}ms:`);
for (const h of hits) {
	console.error(`  ${h.score.toFixed(3)}  ${h.sku.padEnd(12)} ${h.name}  ($${h.priceUsd})`);
}

catalog.close();
console.error('[seed-catalog] done.');
