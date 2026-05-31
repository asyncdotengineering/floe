/**
 * Purchase flow — first-principles shape.
 *
 *   collect-intent (Extraction: sku, size, qty)
 *     → check-stock (Compute: deterministic DB lookup + price)
 *         ├→ confirm-purchase (Reply, ends T0 — user sees total + asks yes/no)
 *         └→ stock-unavailable (Reply, ends flow)
 *
 *   T+1: capture-confirm (Capture: yes/no classify)
 *         ├→ place-order (Compute: actually create order)
 *         │      └→ order-placed (Reply, ends flow)
 *         └→ purchase-declined (Reply, ends flow)
 *
 * Stock + price come from the catalog. The LLM only extracts intent +
 * writes user-facing copy.
 */
import {
	defineCaptureNode,
	defineComputeNode,
	defineExtractionNode,
	defineFlow,
	defineReplyNode,
} from '@floe/runtime';
import * as v from 'valibot';
import type { CatalogHandle } from '../lib/catalog.ts';

export function buildPurchaseFlow(catalog: CatalogHandle) {
	// Forward decls so the graph can self-reference.
	let checkStock: ReturnType<typeof defineCheckStock>;
	let confirmPurchase: ReturnType<typeof defineConfirmPurchase>;
	let captureConfirm: ReturnType<typeof defineCaptureConfirm>;
	let placeOrder: ReturnType<typeof definePlaceOrder>;
	let orderPlaced: ReturnType<typeof defineOrderPlaced>;
	let purchaseDeclined: ReturnType<typeof definePurchaseDeclined>;
	let stockUnavailable: ReturnType<typeof defineStockUnavailable>;

	const collectIntent = defineExtractionNode({
		name: 'collect-purchase-intent',
		prompt: `Collect three fields the customer wants to buy:

  - **sku** — the catalog SKU (format ABC-XX-NNN, e.g. ATL-DJ-001). Use Reference material rows that start with "PRODUCT: <name>  (SKU: <SKU>)" to match the customer's product. NEVER invent a SKU; if no row matches, the field stays empty.
  - **size** — XS/S/M/L/XL/XXL for clothing, numeric (6, 7, …, 13) for sneakers, "one-size" for bags/scarves.
  - **qty** — positive integer (default 1).

If they gave everything in one message, submit all. If only some, submit those and ask warmly for the rest in ONE short sentence.`,
		schema: v.object({
			sku: v.string(),
			size: v.string(),
			qty: v.number(),
		}),
		requiredFields: ['sku', 'size', 'qty'],
		async onComplete({ sku, size, qty }, ctx) {
			ctx.state.sku = sku;
			ctx.state.size = size;
			ctx.state.qty = Math.max(1, qty);
			return { kind: 'node', node: checkStock };
		},
	});

	function defineCheckStock() {
		return defineComputeNode({
			name: 'check-stock',
			async compute(ctx) {
				const sku = ctx.state.sku as string;
				const size = ctx.state.size as string;
				const product = await catalog.getProduct(sku);
				if (!product) {
					ctx.state.stockError = 'sku_not_found';
					return { kind: 'node', node: stockUnavailable };
				}
				if (!product.sizesAvailable.includes(size)) {
					ctx.state.stockError = 'size_not_offered';
					ctx.state.offeredSizes = product.sizesAvailable;
					ctx.state.productName = product.name;
					return { kind: 'node', node: stockUnavailable };
				}
				const stock = product.stockBySize[size] ?? 0;
				ctx.state.productName = product.name;
				ctx.state.priceUsd = product.priceUsd;
				ctx.state.stock = stock;
				if (stock <= 0) {
					ctx.state.stockError = undefined;
					return { kind: 'node', node: stockUnavailable };
				}
				const qty = ctx.state.qty as number;
				ctx.state.totalUsd = product.priceUsd * qty;
				return { kind: 'node', node: confirmPurchase };
			},
		});
	}
	checkStock = defineCheckStock();

	function defineConfirmPurchase() {
		return defineReplyNode({
			name: 'confirm-purchase',
			prompt: (ctx) => {
				const s = ctx.state as {
					productName: string;
					size: string;
					qty: number;
					priceUsd: number;
					totalUsd: number;
				};
				return `Summarize the pending order and ask for yes/no. Output 1–2 sentences, plain prose, no markdown.

# Inputs

- productName: ${s.productName}
- size: ${s.size}
- qty: ${s.qty}
- priceUsd: ${s.priceUsd}
- totalUsd: ${s.totalUsd}

# Output rules

- MUST contain "${s.productName}", "$${s.priceUsd}" (per unit), AND "$${s.totalUsd}" (total).
- Use one of: "Ready to place this order?", "Shall I confirm and place it?", "Want me to place it?".

# Example

"I have ${s.qty}× ${s.productName} (size ${s.size}) at $${s.priceUsd} each — total $${s.totalUsd}. Ready to place this order?"`;
			},
			next: () => ({ kind: 'node', node: captureConfirm }),
		});
	}
	confirmPurchase = defineConfirmPurchase();

	function defineCaptureConfirm() {
		return defineCaptureNode({
			name: 'capture-confirm',
			prompt: `The customer's last message is a reply to "Ready to place this order?" Classify as confirmed (true) or declined / ambiguous (false). Emit ONLY the structured result.`,
			schema: v.object({ confirmed: v.boolean() }),
			async handler({ confirmed }, _ctx) {
				if (!confirmed) return { kind: 'node', node: purchaseDeclined };
				return { kind: 'node', node: placeOrder };
			},
		});
	}
	captureConfirm = defineCaptureConfirm();

	function definePlaceOrder() {
		return defineComputeNode({
			name: 'place-order',
			async compute(ctx) {
				const sku = ctx.state.sku as string;
				const size = ctx.state.size as string;
				const qty = ctx.state.qty as number;
				const priceUsd = ctx.state.priceUsd as number;
				const orderId = `ord_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
				ctx.state.orderId = orderId;
				ctx.state.totalUsd = priceUsd * qty;
				ctx.state.placedAt = new Date().toISOString();
				return { kind: 'node', node: orderPlaced };
			},
		});
	}
	placeOrder = definePlaceOrder();

	function defineOrderPlaced() {
		return defineReplyNode({
			name: 'order-placed',
			prompt: (ctx) => {
				const s = ctx.state as {
					orderId: string;
					productName: string;
					size: string;
					qty: number;
					totalUsd: number;
				};
				return `Confirm the order is placed. ONE sentence, plain prose. MUST contain "${s.orderId}" AND "$${s.totalUsd}" AND the word "placed" or "confirmed".

Example: "Order ${s.orderId} placed — ${s.qty}× ${s.productName} (size ${s.size}) for $${s.totalUsd} total."`;
			},
			next: { kind: 'end', reason: 'order placed' },
		});
	}
	orderPlaced = defineOrderPlaced();

	function definePurchaseDeclined() {
		return defineReplyNode({
			name: 'purchase-declined',
			prompt: `Acknowledge briefly that the order was not placed and offer to help with anything else. ONE short sentence.`,
			next: { kind: 'end', reason: 'customer cancelled before placing order' },
		});
	}
	purchaseDeclined = definePurchaseDeclined();

	function defineStockUnavailable() {
		return defineReplyNode({
			name: 'stock-unavailable',
			prompt: (ctx) => {
				const s = ctx.state as {
					stockError?: string;
					offeredSizes?: string[];
					productName?: string;
					size?: string;
				};
				return `The product or size isn't available. Tell the customer briefly + offer ONE specific next step. 1–2 sentences, plain prose.

# State

- stockError: ${s.stockError ?? '(none — just out of stock)'}
- offeredSizes: ${s.offeredSizes ? s.offeredSizes.join(', ') : '(n/a)'}
- productName: ${s.productName ?? '(unknown)'}
- size: ${s.size ?? '(unknown)'}

# Branching

- If stockError = "size_not_offered": tell them which sizes ARE offered, ask if they want a different size.
- If stockError = "sku_not_found": tell them you can't find that product, ask them to describe it.
- Otherwise (just out of stock): say it's out of stock right now, ask if they want a restock notification.`;
			},
			next: { kind: 'end', reason: 'purchase blocked: stock unavailable' },
		});
	}
	stockUnavailable = defineStockUnavailable();

	return defineFlow({
		name: 'purchase',
		description:
			'Buy a specific product: extract sku + size + quantity, check stock + price deterministically, ask user to confirm, place the order. Triggered when the customer wants to BUY / CHECKOUT / ORDER a specific item.',
		startNode: () => collectIntent,
	});
}
