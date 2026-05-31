/**
 * Order tracking mock. Each order has items, status, tracking URL,
 * scheduled arrival, optional delivered-at and issue note.
 */
import * as v from 'valibot';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { defineMockService, type MockService } from '../define-mock-service.ts';

export interface OrderItem {
	sku: string;
	name: string;
	qty: number;
}

export interface Order {
	id: string;
	userId: string;
	items: OrderItem[];
	status: 'pending' | 'in_transit' | 'delivered' | 'issue' | 'canceled';
	trackingUrl: string;
	scheduledArrival: string;
	deliveredAt: string | null;
	issueNote?: string;
}

const seedPath = resolvePath(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'seeds',
	'order.json',
);

export interface OrderServiceOptions {
	seed?: Order[] | string;
}

export async function orderService(
	opts: OrderServiceOptions = {},
): Promise<MockService<Order>> {
	return defineMockService<Order>({
		name: 'order',
		seed: opts.seed ?? seedPath,
		operations: {
			lookup_order: {
				description: 'Get an order by id.',
				input: v.object({ orderId: v.string() }),
				handler: ({ orderId }, store) => store.get(orderId),
			},
			list_orders_by_user: {
				description: 'List recent orders for a userId. Newest first. Returns up to `limit` (default 10).',
				input: v.object({ userId: v.string(), limit: v.optional(v.number()) }),
				handler: ({ userId, limit }, store) =>
					store.list().filter((o) => o.userId === userId).slice(0, limit ?? 10),
			},
			report_issue: {
				description: 'Mark an order with a customer-reported issue. Returns the updated order.',
				input: v.object({ orderId: v.string(), issueNote: v.string() }),
				handler: ({ orderId, issueNote }, store) =>
					store.update(orderId, { status: 'issue', issueNote }),
			},
		},
	});
}
