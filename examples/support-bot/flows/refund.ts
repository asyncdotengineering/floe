/**
 * Refund flow — first-principles shape.
 *
 *   collect-invoice (Extraction) → lookup-invoice (Compute)
 *                                       ├→ ask-confirmation (Reply) → capture-confirmation (Capture)
 *                                       │                                  ├→ process-refund (Compute) → refund-done (Reply, end)
 *                                       │                                  └→ refund-declined (Reply, end)
 *                                       ├→ explain-denial (Reply, end)
 *                                       └→ invoice-not-found (Reply, end)
 *
 * Eligibility math is pure TS (`computeRefundEligibility`); the LLM only
 * extracts the invoice + reason and writes user-facing text.
 */
import {
	defineCaptureNode,
	defineComputeNode,
	defineExtractionNode,
	defineFlow,
	defineReplyNode,
} from '@floe/runtime';
import * as v from 'valibot';

// In-process mock invoice table.
const INVOICES: Record<
	string,
	{ amountUsd: number; paidOn: string | null; ageDays: number; planTier: string }
> = {
	inv_881: { amountUsd: 89, paidOn: '2026-04-12', ageDays: 40, planTier: 'pro' },
	inv_902: { amountUsd: 19, paidOn: null, ageDays: 12, planTier: 'starter' },
	inv_770: { amountUsd: 49, paidOn: '2025-12-20', ageDays: 152, planTier: 'starter' },
};

// Forward declarations.
let lookupInvoice: ReturnType<typeof defineLookupInvoice>;
let askConfirmation: ReturnType<typeof defineAskConfirmation>;
let captureConfirmation: ReturnType<typeof defineCaptureConfirmation>;
let processRefund: ReturnType<typeof defineProcessRefund>;
let refundDone: ReturnType<typeof defineRefundDone>;
let refundDeclined: ReturnType<typeof defineRefundDeclined>;
let explainDenial: ReturnType<typeof defineExplainDenial>;
let invoiceNotFound: ReturnType<typeof defineInvoiceNotFound>;

const collectInvoice = defineExtractionNode({
	name: 'collect-invoice',
	prompt: `Collect two fields to start a refund:

  - **invoiceId** — format inv_NNN (e.g. inv_881).
  - **statedReason** — short summary of why they want a refund, in the customer's own words.

If they gave both in one message, submit both. If only one, submit it and ask warmly for the other in ONE short sentence.`,
	schema: v.object({
		invoiceId: v.string(),
		statedReason: v.string(),
	}),
	requiredFields: ['invoiceId', 'statedReason'],
	async onComplete({ invoiceId, statedReason }, ctx) {
		ctx.state.invoiceId = invoiceId;
		ctx.state.statedReason = statedReason;
		return { kind: 'node', node: lookupInvoice };
	},
});

function defineLookupInvoice() {
	return defineComputeNode({
		name: 'lookup-invoice',
		compute(ctx) {
			const invoiceId = ctx.state.invoiceId as string;
			const invoice = INVOICES[invoiceId];
			if (!invoice) {
				ctx.state.lookupError = 'invoice_not_found';
				return { kind: 'node', node: invoiceNotFound };
			}
			const e = computeRefundEligibility(invoice.amountUsd, invoice.ageDays);
			ctx.state.invoiceAmountUsd = invoice.amountUsd;
			ctx.state.invoiceAgeDays = invoice.ageDays;
			ctx.state.refundAmountUsd = e.refundAmountUsd;
			ctx.state.eligibilityReasoning = e.reasoning;
			if (!e.eligible) return { kind: 'node', node: explainDenial };
			return { kind: 'node', node: askConfirmation };
		},
	});
}
lookupInvoice = defineLookupInvoice();

function defineAskConfirmation() {
	return defineReplyNode({
		name: 'ask-confirmation',
		prompt: (ctx) => {
			const s = ctx.state as {
				invoiceId: string;
				refundAmountUsd: number;
				eligibilityReasoning: string;
			};
			return `Tell the customer their refund is eligible and ask for explicit confirmation. ONE sentence stating eligibility + amount, ONE sentence asking yes/no. Plain prose.

# Inputs

- invoiceId: ${s.invoiceId}
- refundAmountUsd: ${s.refundAmountUsd}
- eligibilityReasoning: ${s.eligibilityReasoning}

# Output rules

- First sentence MUST contain literal "${s.invoiceId}" AND literal "$${s.refundAmountUsd}".
- Second sentence MUST be one of: "Shall I process the refund?", "Would you like me to process it?", "Want me to process the refund?".

Example: "Invoice ${s.invoiceId} qualifies for a refund of $${s.refundAmountUsd}. Shall I process the refund?"`;
		},
		next: () => ({ kind: 'node', node: captureConfirmation }),
	});
}
askConfirmation = defineAskConfirmation();

function defineCaptureConfirmation() {
	return defineCaptureNode({
		name: 'capture-confirmation',
		prompt: `The customer's last message is a reply to "process the refund?" Classify confirmed (true) or declined / ambiguous (false). Emit ONLY the structured result.`,
		schema: v.object({ confirmed: v.boolean() }),
		async handler({ confirmed }, _ctx) {
			if (!confirmed) return { kind: 'node', node: refundDeclined };
			return { kind: 'node', node: processRefund };
		},
	});
}
captureConfirmation = defineCaptureConfirmation();

function defineProcessRefund() {
	return defineComputeNode({
		name: 'process-refund',
		async compute(ctx) {
			ctx.state.refundId = `re_${Math.random().toString(36).slice(2, 10)}`;
			ctx.state.processedAt = new Date().toISOString();
			return { kind: 'node', node: refundDone };
		},
	});
}
processRefund = defineProcessRefund();

function defineRefundDone() {
	return defineReplyNode({
		name: 'refund-done',
		prompt: (ctx) => {
			const s = ctx.state as { refundId: string; refundAmountUsd: number; invoiceId: string };
			return `Tell the customer their refund is processed. ONE sentence. MUST contain "${s.refundId}" AND "$${s.refundAmountUsd}" AND the word "processed". Plain prose.

Example: "Done — refund ${s.refundId} for $${s.refundAmountUsd} on invoice ${s.invoiceId} has been processed."`;
		},
		next: { kind: 'end', reason: 'refund processed' },
	});
}
refundDone = defineRefundDone();

function defineRefundDeclined() {
	return defineReplyNode({
		name: 'refund-declined',
		prompt: (ctx) => {
			const s = ctx.state as { invoiceId: string };
			return `Acknowledge briefly that invoice ${s.invoiceId} was NOT refunded. Offer to help with something else. ONE sentence.`;
		},
		next: { kind: 'end', reason: 'customer declined refund' },
	});
}
refundDeclined = defineRefundDeclined();

function defineExplainDenial() {
	return defineReplyNode({
		name: 'explain-denial',
		prompt: (ctx) => {
			const s = ctx.state as { invoiceId: string; invoiceAgeDays: number };
			return `Politely explain invoice ${s.invoiceId} (${s.invoiceAgeDays} days old) is outside our 90-day refund window. Offer two specific alternatives: store credit OR escalation to a billing manager. 2 sentences, plain prose, no "unfortunately".`;
		},
		next: { kind: 'end', reason: 'refund denied per policy' },
	});
}
explainDenial = defineExplainDenial();

function defineInvoiceNotFound() {
	return defineReplyNode({
		name: 'invoice-not-found',
		prompt: (ctx) => {
			const s = ctx.state as { invoiceId: string };
			return `We couldn't find invoice ${s.invoiceId}. ONE sentence: mention "${s.invoiceId}" and ask the customer to double-check the id.`;
		},
		next: { kind: 'end', reason: 'refund blocked: invoice not found' },
	});
}
invoiceNotFound = defineInvoiceNotFound();

function computeRefundEligibility(
	amountUsd: number,
	ageDays: number,
): { eligible: boolean; refundAmountUsd: number; reasoning: string } {
	if (ageDays <= 30) {
		return {
			eligible: true,
			refundAmountUsd: round2(amountUsd),
			reasoning: `Invoice is ${ageDays} days old — within the 30-day full-refund window.`,
		};
	}
	if (ageDays <= 90) {
		return {
			eligible: true,
			refundAmountUsd: round2(amountUsd * 0.5),
			reasoning: `Invoice is ${ageDays} days old — within the 31-90 day window for a 50% refund.`,
		};
	}
	return {
		eligible: false,
		refundAmountUsd: 0,
		reasoning: `Invoice is ${ageDays} days old — beyond the 90-day window.`,
	};
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

export const refundFlow = defineFlow({
	name: 'refund',
	description:
		'Multi-step refund handling: extract invoice + reason, look up the invoice, compute eligibility, ask the user to confirm, then process or deny. Triggered when the customer asks for a refund or money back on a specific invoice.',
	startNode: () => collectInvoice,
});
