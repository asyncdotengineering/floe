/**
 * Meal-kit subscription mock. Subscriptions have user, plan, price,
 * status, next delivery, skipped weeks, address, preferences.
 * Operations cover the high-volume cases a B2C subscription bot hits
 * every turn: skip a week, change address, pause, cancel, refund.
 */
import * as v from 'valibot';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { defineMockService, type MockService } from '../define-mock-service.ts';

export interface Subscription {
	id: string;
	userId: string;
	email: string;
	plan: string;
	pricePerWeek: number;
	status: 'active' | 'paused' | 'canceled';
	nextDeliveryDate: string | null;
	skippedWeeks: string[];
	address: string;
	deliveryWindow: string;
	lastChargedAt: string;
	preferences: {
		spice: 'mild' | 'medium' | 'hot';
		allergens: string[];
		dietary: string[];
	};
}

const seedPath = resolvePath(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'seeds',
	'subscription.json',
);

export interface SubscriptionServiceOptions {
	seed?: Subscription[] | string;
}

export async function subscriptionService(
	opts: SubscriptionServiceOptions = {},
): Promise<MockService<Subscription>> {
	return defineMockService<Subscription>({
		name: 'subscription',
		seed: opts.seed ?? seedPath,
		operations: {
			lookup_subscription: {
				description: 'Find a subscription by email or userId. Returns the full subscription record or null.',
				input: v.object({ email: v.optional(v.string()), userId: v.optional(v.string()) }),
				handler: ({ email, userId }, store) => {
					if (email)
						return store.find((s) => s.email.toLowerCase() === email.toLowerCase());
					if (userId) return store.find((s) => s.userId === userId);
					return null;
				},
			},
			skip_week: {
				description: 'Skip a specific delivery week (YYYY-MM-DD). Returns updated subscription with savings = pricePerWeek.',
				input: v.object({ subscriptionId: v.string(), weekStartDate: v.string() }),
				handler: ({ subscriptionId, weekStartDate }, store) => {
					const sub = store.get(subscriptionId);
					if (!sub) return { error: 'unknown_subscription' };
					if (sub.skippedWeeks.includes(weekStartDate)) {
						return { error: 'already_skipped', weekStartDate };
					}
					store.update(subscriptionId, {
						skippedWeeks: [...sub.skippedWeeks, weekStartDate],
					});
					return { ok: true, savings: sub.pricePerWeek, subscription: store.get(subscriptionId) };
				},
			},
			pause_subscription: {
				description: 'Pause a subscription indefinitely. Clears nextDeliveryDate.',
				input: v.object({ subscriptionId: v.string() }),
				handler: ({ subscriptionId }, store) => {
					const sub = store.get(subscriptionId);
					if (!sub) return { error: 'unknown_subscription' };
					return store.update(subscriptionId, { status: 'paused', nextDeliveryDate: null });
				},
			},
			cancel_subscription: {
				description: 'Cancel a subscription. Optional reason for retention analytics.',
				input: v.object({ subscriptionId: v.string(), reason: v.optional(v.string()) }),
				handler: ({ subscriptionId }, store) => {
					const sub = store.get(subscriptionId);
					if (!sub) return { error: 'unknown_subscription' };
					return store.update(subscriptionId, { status: 'canceled', nextDeliveryDate: null });
				},
			},
			update_address: {
				description: 'Change the delivery address. Returns the updated subscription.',
				input: v.object({ subscriptionId: v.string(), address: v.string() }),
				handler: ({ subscriptionId, address }, store) => store.update(subscriptionId, { address }),
			},
			issue_refund: {
				description: 'Issue a refund for a specific past delivery. Returns a refund id and amount. (Mock: always succeeds.)',
				input: v.object({
					subscriptionId: v.string(),
					amountUsd: v.number(),
					reason: v.string(),
				}),
				handler: ({ subscriptionId, amountUsd, reason }, store) => {
					const sub = store.get(subscriptionId);
					if (!sub) return { error: 'unknown_subscription' };
					return {
						ok: true,
						refundId: `ref_${Math.random().toString(36).slice(2, 10)}`,
						amountUsd,
						reason,
						subscriptionId,
					};
				},
			},
		},
	});
}
