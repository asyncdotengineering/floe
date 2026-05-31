/**
 * Multi-step return flow — first-principles shape.
 *
 *   collect-order (Extraction) ─→ lookup-order (Compute) ─→ ask-confirmation (Reply, ends T0)
 *                                                       └→ explain-denial   (Reply, ends turn)
 *                                                       └→ order-not-found  (Reply, ends turn)
 *
 *   T+1:  user replies "yes"/"no" ─→ capture-confirmation (Capture)
 *                                          ├→ process-refund (Compute) ─→ refund-confirmed (Reply, ends flow)
 *                                          └→ return-declined (Reply, ends flow)
 *
 * Every LLM-calling node has ONE explicit responsibility:
 *   - Extraction collects user-supplied data
 *   - Capture classifies a single user message into a typed result
 *   - Reply produces user-facing text in a fresh child session (no context bleed)
 *   - Compute runs deterministic business logic with NO LLM call
 *
 * Refund math lives in `computeReturnEligibility` — never trusted to an LLM.
 */
import {
	defineCaptureNode,
	defineComputeNode,
	defineExtractionNode,
	defineFlow,
	defineReplyNode,
	defineTool,
} from '@floe/runtime';
import * as v from 'valibot';
import { ORDERS } from '../lib/orders.ts';

// ─── Tools ────────────────────────────────────────────────────────────────

const processReturnTool = defineTool({
	name: 'processReturn',
	description: 'Issue a return for an order. Call ONLY after explicit customer confirmation.',
	parameters: v.object({
		orderId: v.string(),
		refundAmountUsd: v.number(),
		reason: v.string(),
	}),
	async execute({ orderId, refundAmountUsd, reason }) {
		return {
			returnId: `rtn_${Math.random().toString(36).slice(2, 10)}`,
			orderId,
			refundAmountUsd,
			reason,
			processedAt: new Date().toISOString(),
		};
	},
});

// Forward declarations so the graph can self-reference.
let lookupOrder: ReturnType<typeof defineLookupOrder>;
let askConfirmation: ReturnType<typeof defineAskConfirmation>;
let captureConfirmation: ReturnType<typeof defineCaptureConfirmation>;
let processRefund: ReturnType<typeof defineProcessRefund>;
let refundConfirmed: ReturnType<typeof defineRefundConfirmed>;
let returnDeclined: ReturnType<typeof defineReturnDeclined>;
let explainDenial: ReturnType<typeof defineExplainDenial>;
let orderNotFound: ReturnType<typeof defineOrderNotFound>;

// ─── 1. Collect (Extraction — multi-turn if needed) ─────────────────────

const collectOrder = defineExtractionNode({
	name: 'collect-order',
	prompt: `You are collecting two pieces of information from the customer to start a return:

  - **orderId** — in the format ord_NNNN (e.g. ord_2240).
  - **statedReason** — a short summary of why they want to return, in the customer's own words.

If both are present in the user's message (even casually, like "I want to return ord_2240 because the fit was wrong"), submit both at once. If only one is clear, submit it and ask warmly for the other in ONE short sentence. Never re-ask for a field you've already collected.

Common reason phrasings that count as a real reason — submit them: "fit was wrong", "didn't fit", "too small", "too big", "wrong color", "shrunk", "doesn't fit", "the shirts shrunk", "broke", "defective", "changed my mind", "wrong item".`,
	schema: v.object({
		orderId: v.string(),
		statedReason: v.string(),
	}),
	requiredFields: ['orderId', 'statedReason'],
	async onComplete({ orderId, statedReason }, ctx) {
		ctx.state.orderId = orderId;
		ctx.state.statedReason = statedReason;
		return { kind: 'node', node: lookupOrder };
	},
});

// ─── 2. Lookup + math (Compute — deterministic, NO LLM) ─────────────────

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
			const e = computeReturnEligibility(order.totalUsd, order.ageDays);
			ctx.state.totalUsd = order.totalUsd;
			ctx.state.ageDays = order.ageDays;
			ctx.state.refundAmountUsd = e.refundAmountUsd;
			ctx.state.refundType = e.refundType;
			ctx.state.eligibilityReasoning = e.reasoning;
			if (!e.eligible) return { kind: 'node', node: explainDenial };
			return { kind: 'node', node: askConfirmation };
		},
	});
}
lookupOrder = defineLookupOrder();

// ─── 3a. Ask for confirmation (Reply — ends T0) ─────────────────────────

function defineAskConfirmation() {
	return defineReplyNode({
		name: 'ask-confirmation',
		prompt: (ctx) => {
			const s = ctx.state as {
				orderId: string;
				refundType: string;
				refundAmountUsd: number;
				eligibilityReasoning: string;
			};
			return `You are an Acme Threads concierge. Tell the customer their return is approved and ask for confirmation to process it. Output 2 sentences, plain prose, no markdown.

# Inputs (from system, not the user)

- orderId: ${s.orderId}
- refundType: ${s.refundType}
- refundAmountUsd: ${s.refundAmountUsd}
- eligibilityReasoning: ${s.eligibilityReasoning}

# Output rules (STRICT)

- First sentence: state eligibility + amount. MUST contain the literal "${s.orderId}" AND the literal "$${s.refundAmountUsd}". Never use "your order", "the amount", "the refund", or any paraphrase of those values.
- Second sentence: ask for confirmation. MUST be exactly one of:
  - "Shall I confirm and process the refund?"
  - "Would you like me to confirm and process the refund?"
  - "Want me to confirm and process the refund?"
- No closing remarks, no "feel free to ask", no extras after the confirmation question.

# Example

"Good news — order ord_2240 is within our 30-day window, so you're eligible for a full refund of $189. Shall I confirm and process the refund?"`;
		},
		next: () => ({ kind: 'node', node: captureConfirmation }),
	});
}
askConfirmation = defineAskConfirmation();

// ─── 4. Capture user's yes/no (Capture — single-shot structured) ────────

function defineCaptureConfirmation() {
	return defineCaptureNode({
		name: 'capture-confirmation',
		prompt: `# Task

The customer's last message is a reply to "Shall I confirm and process the refund?" Classify it.

# Classification rules

- **Confirmed** (\`confirmed: true\`): "yes", "sure", "go ahead", "proceed", "please do", "process it", "do it", "confirm", "let's do it", "yep", "yeah", "👍", or any other clear affirmation.
- **Declined** (\`confirmed: false\`): "no", "wait", "cancel", "not now", "hold on", "stop", "nevermind", "actually no", or any clear negative / hesitation.
- **Ambiguous** (anything else — a new question, "let me think", silence): \`confirmed: false\` for safety.

Emit ONLY the structured result. Do NOT respond with text.`,
		schema: v.object({
			confirmed: v.boolean(),
		}),
		async handler({ confirmed }, _ctx) {
			if (!confirmed) return { kind: 'node', node: returnDeclined };
			return { kind: 'node', node: processRefund };
		},
	});
}
captureConfirmation = defineCaptureConfirmation();

// ─── 5. Process the refund (Compute — deterministic) ────────────────────

function defineProcessRefund() {
	return defineComputeNode({
		name: 'process-refund',
		async compute(ctx) {
			const result = await processReturnTool.execute(
				{
					orderId: ctx.state.orderId as string,
					refundAmountUsd: ctx.state.refundAmountUsd as number,
					reason: ctx.state.statedReason as string,
				},
				{} as never,
			);
			const data = result as { returnId: string };
			ctx.state.returnId = data.returnId;
			return { kind: 'node', node: refundConfirmed };
		},
	});
}
processRefund = defineProcessRefund();

// ─── 6a. Refund confirmed (Reply — ends flow) ───────────────────────────

function defineRefundConfirmed() {
	return defineReplyNode({
		name: 'refund-confirmed',
		prompt: (ctx) => {
			const s = ctx.state as { orderId: string; refundAmountUsd: number; returnId: string };
			return `Tell the customer their refund has been processed. Output ONE sentence, plain prose.

# Inputs

- orderId: ${s.orderId}
- refundAmountUsd: ${s.refundAmountUsd}
- returnId: ${s.returnId}

# Output rules (STRICT)

- MUST contain "${s.returnId}" (the return id) AND "$${s.refundAmountUsd}" (the amount) AND the word "processed".
- Friendly, brief, no "is there anything else".

# Example

"Done — refund ${s.returnId} for $${s.refundAmountUsd} on order ${s.orderId} has been processed."`;
		},
		next: { kind: 'end', reason: 'return processed' },
	});
}
refundConfirmed = defineRefundConfirmed();

// ─── 6b. Return declined (Reply — ends flow) ─────────────────────────────

function defineReturnDeclined() {
	return defineReplyNode({
		name: 'return-declined',
		prompt: (ctx) => {
			const s = ctx.state as { orderId: string };
			return `The customer declined to process the refund for order ${s.orderId}. Acknowledge briefly and offer to help with anything else. ONE short sentence. Plain prose.

Example: "No problem — order ${s.orderId} has not been refunded. Anything else I can help with?"`;
		},
		next: { kind: 'end', reason: 'customer declined return' },
	});
}
returnDeclined = defineReturnDeclined();

// ─── 7. Explain denial (Reply — ends flow) ───────────────────────────────

function defineExplainDenial() {
	return defineReplyNode({
		name: 'explain-denial',
		prompt: (ctx) => {
			const s = ctx.state as { orderId: string; ageDays: number };
			return `Tell the customer their order is past the return window, then offer two specific alternatives. Output 2 sentences, plain prose, no "unfortunately".

# Inputs

- orderId: ${s.orderId}
- ageDays: ${s.ageDays}

# Output rules

- First sentence: state the situation. MUST contain "${s.orderId}".
- Second sentence: offer EXACTLY these two options — (a) escalate to a billing manager for a possible exception, OR (b) $25 store credit if the item appears defective — and ask which works better.

# Example

"Order ord_2310 was delivered ${s.ageDays} days ago, which is past our 90-day return window. I can either escalate this to a billing manager to see if an exception is possible, or issue you $25 in store credit if the shirts arrived with a defect — which works better?"`;
		},
		next: { kind: 'end', reason: 'return denied per policy' },
	});
}
explainDenial = defineExplainDenial();

// ─── 8. Order not found (Reply — ends flow) ──────────────────────────────

function defineOrderNotFound() {
	return defineReplyNode({
		name: 'order-not-found',
		prompt: (ctx) => {
			const s = ctx.state as { orderId: string };
			return `We couldn't find order id ${s.orderId} in our system. Tell the customer briefly and offer a specific next step. ONE short sentence. Plain prose.

Output rules: MUST contain "${s.orderId}". Offer ONE specific next step (e.g. ask them to double-check the id, OR offer to look up the order by email).

Example: "I couldn't find order ${s.orderId} in our system — could you double-check the id? It usually looks like ord_NNNN."`;
		},
		next: { kind: 'end', reason: 'return blocked: order not found' },
	});
}
orderNotFound = defineOrderNotFound();

// ─── Pure business rules — the only place return policy lives ───────────

export function computeReturnEligibility(
	totalUsd: number,
	ageDays: number,
): {
	eligible: boolean;
	refundAmountUsd: number;
	refundType: 'a full refund' | '50% store credit' | 'no refund';
	reasoning: string;
} {
	if (ageDays <= 30) {
		return {
			eligible: true,
			refundAmountUsd: round2(totalUsd),
			refundType: 'a full refund',
			reasoning: `Order is ${ageDays} days old — within the 30-day full-refund window.`,
		};
	}
	if (ageDays <= 90) {
		return {
			eligible: true,
			refundAmountUsd: round2(totalUsd * 0.5),
			refundType: '50% store credit',
			reasoning: `Order is ${ageDays} days old — within the 31-90 day window for 50% store credit.`,
		};
	}
	return {
		eligible: false,
		refundAmountUsd: 0,
		refundType: 'no refund',
		reasoning: `Order is ${ageDays} days old — beyond our 90-day window.`,
	};
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

export const returnFlow = defineFlow({
	name: 'return',
	description:
		'Multi-step return / refund handling: extract order id + reason, look up the order, compute eligibility deterministically, ask the user to confirm, then process. Triggered when a customer asks to return, refund, or send back an item from a specific order.',
	startNode: () => collectOrder,
});
