/**
 * Mock order store. Shared by `return` + `track-order` flows. Real apps
 * wire this to your OMS / Shopify / etc.
 */
export const ORDERS: Record<string, {
	orderId: string;
	customer: string;
	items: Array<{ sku: string; name: string; size?: string; qty: number; priceUsd: number }>;
	totalUsd: number;
	placedOn: string;
	deliveredOn: string | null;
	ageDays: number;
	status: 'placed' | 'shipped' | 'delivered' | 'returned';
	trackingNumber?: string;
}> = {
	ord_2240: {
		orderId: 'ord_2240',
		customer: 'alice',
		items: [{ sku: 'ATL-DJ-001', name: 'Atlas Down Jacket', size: 'M', qty: 1, priceUsd: 189 }],
		totalUsd: 189,
		placedOn: '2026-04-18',
		deliveredOn: '2026-04-25',
		ageDays: 27,
		status: 'delivered',
		trackingNumber: 'TRK-9912-001',
	},
	ord_2310: {
		orderId: 'ord_2310',
		customer: 'alice',
		items: [{ sku: 'ECH-TS-004', name: 'Echo Pima T-Shirt', size: 'M', qty: 2, priceUsd: 42 }],
		totalUsd: 84,
		placedOn: '2026-02-12',
		deliveredOn: '2026-02-20',
		ageDays: 91,
		status: 'delivered',
	},
	ord_2401: {
		orderId: 'ord_2401',
		customer: 'bob',
		items: [{ sku: 'HRZ-SN-002', name: 'Horizon Daily Sneaker', size: '10', qty: 1, priceUsd: 128 }],
		totalUsd: 128,
		placedOn: '2026-05-15',
		deliveredOn: null,
		ageDays: 0,
		status: 'shipped',
		trackingNumber: 'TRK-9923-444',
	},
};
