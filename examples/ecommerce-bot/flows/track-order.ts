/**
 * Track-order flow — first-principles shape.
 *
 *   collect-order-id (Extraction) ─→ lookup-order (Compute) ─→ format-tracking (Reply, ends flow)
 *
 * No `result + tools` node — the old `format-tracking` that fused tool
 * call + structured result extraction was the same architectural smell
 * as the deleted `check-eligibility`. Now lookup is a pure Compute call;
 * the LLM only handles text formatting in a fresh child session.
 */
import {
	defineComputeNode,
	defineExtractionNode,
	defineFlow,
	defineReplyNode,
} from '@floe/runtime';
import * as v from 'valibot';
import { ORDERS } from '../lib/orders.ts';

let lookupOrder: ReturnType<typeof defineLookupOrder>;
let formatTracking: ReturnType<typeof defineFormatTracking>;
let orderNotFound: ReturnType<typeof defineOrderNotFound>;

const collectOrderId = defineExtractionNode({
	name: 'collect-order-id',
	prompt: `Collect the order id (format ord_NNNN, e.g. ord_2401) from the customer's message. If they gave it, submit it. If not, ask for it in one warm short sentence.`,
	schema: v.object({ orderId: v.string() }),
	requiredFields: ['orderId'],
	async onComplete({ orderId }, ctx) {
		ctx.state.orderId = orderId;
		return { kind: 'node', node: lookupOrder };
	},
});

function defineLookupOrder() {
	return defineComputeNode({
		name: 'lookup-order',
		compute(ctx) {
			const orderId = ctx.state.orderId as string;
			const order = ORDERS[orderId];
			if (!order) {
				ctx.state.lookupError = 'order_not_found';
				return { kind: 'node', node: orderNotFound };
			}
			ctx.state.status = order.status;
			ctx.state.trackingNumber = order.trackingNumber ?? null;
			ctx.state.deliveredOn = order.deliveredOn ?? null;
			ctx.state.placedOn = order.placedOn;
			return { kind: 'node', node: formatTracking };
		},
	});
}
lookupOrder = defineLookupOrder();

function defineFormatTracking() {
	return defineReplyNode({
		name: 'format-tracking',
		prompt: (ctx) => {
			const s = ctx.state as {
				orderId: string;
				status: string;
				trackingNumber: string | null;
				deliveredOn: string | null;
			};
			return `Tell the customer their order status in ONE short sentence. Plain prose, no markdown.

# Inputs

- orderId: ${s.orderId}
- status: ${s.status}
- trackingNumber: ${s.trackingNumber ?? '(none)'}
- deliveredOn: ${s.deliveredOn ?? '(not delivered)'}

# Output rules

- MUST contain the literal "${s.orderId}".
- MUST mention the status ("${s.status}").
- If trackingNumber is present, include it. If deliveredOn is present, say so naturally.

# Examples

"Order ord_2401 is shipped — tracking number TRK-9923-444."
"Order ord_2240 was delivered on April 25th."`;
		},
		next: { kind: 'end', reason: 'order tracked' },
	});
}
formatTracking = defineFormatTracking();

function defineOrderNotFound() {
	return defineReplyNode({
		name: 'order-not-found',
		prompt: (ctx) => {
			const s = ctx.state as { orderId: string };
			return `We couldn't find order ${s.orderId}. Tell the customer briefly in ONE sentence — mention "${s.orderId}" and ask them to double-check.

Example: "I couldn't find order ${s.orderId} in our system — could you double-check the id? It usually looks like ord_NNNN."`;
		},
		next: { kind: 'end', reason: 'track blocked: order not found' },
	});
}
orderNotFound = defineOrderNotFound();

export const trackOrderFlow = defineFlow({
	name: 'track-order',
	description:
		'Order status / tracking lookup: extract order id, fetch status + tracking, format reply. Triggered when a customer asks "where is my order" / "track my package" / "is my order shipped".',
	startNode: () => collectOrderId,
});
