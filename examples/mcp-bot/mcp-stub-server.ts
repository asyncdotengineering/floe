/**
 * Minimal MCP server for the example. Built on @floe/mock-services —
 * the prior 80-LOC hand-rolled stub is replaced by a `defineMockService`
 * call + `mountMockMcp`.
 *
 * Run alongside `server.ts`:
 *   node --import tsx ./mcp-stub-server.ts &
 *   node --import tsx ./server.ts
 *
 * The Floe agent (floe.config.ts) lazy-connects to http://localhost:3201/mcp
 * on the first turn and exposes `lookup_sku` as `mcp__inventory__lookup_sku`.
 */
import * as v from 'valibot';
import { defineMockService, mountMockMcp } from '@floe/mock-services';

interface Sku {
	id: string; // SKU code, e.g. "SKU-001"
	name: string;
	stock: number;
	priceUsd: number;
}

const inventory = await defineMockService<Sku>({
	name: 'inventory',
	seed: [
		{ id: 'SKU-001', name: 'Steel water bottle', stock: 42, priceUsd: 18 },
		{ id: 'SKU-002', name: 'Bamboo cutting board', stock: 0, priceUsd: 35 },
		{ id: 'SKU-003', name: 'Wool socks (3-pack)', stock: 117, priceUsd: 24 },
	],
	operations: {
		lookup_sku: {
			description:
				'Look up a product by SKU. Returns name, current stock, and unit price in USD.',
			input: v.object({ sku: v.string() }),
			handler: ({ sku }, store) => {
				const item = store.get(sku.toUpperCase());
				if (!item) return `No product found for SKU "${sku}".`;
				return `${item.name} — ${item.stock} in stock at $${item.priceUsd}.`;
			},
		},
	},
});

const handle = await mountMockMcp(inventory, {
	port: Number(process.env.MCP_PORT ?? 3201),
});
console.log(`[mcp-stub] listening on ${handle.url}`);

process.on('SIGINT', async () => {
	await handle.stop();
	process.exit(0);
});
process.on('SIGTERM', async () => {
	await handle.stop();
	process.exit(0);
});
