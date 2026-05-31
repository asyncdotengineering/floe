/**
 * Account-change flow — first-principles shape.
 *
 *   collect-change (Extraction) → ask-confirm-change (Reply, ends T0)
 *   T+1: capture-confirm-change (Capture) → apply-change (Compute) → change-done (Reply, end)
 *                                       └→ change-cancelled (Reply, end)
 */
import {
	defineCaptureNode,
	defineComputeNode,
	defineExtractionNode,
	defineFlow,
	defineReplyNode,
} from '@floe/runtime';
import * as v from 'valibot';

let askConfirmChange: ReturnType<typeof defineAskConfirmChange>;
let captureConfirmChange: ReturnType<typeof defineCaptureConfirmChange>;
let applyChange: ReturnType<typeof defineApplyChange>;
let changeDone: ReturnType<typeof defineChangeDone>;
let changeCancelled: ReturnType<typeof defineChangeCancelled>;

const collectChange = defineExtractionNode({
	name: 'collect-change',
	prompt: `Collect three fields for a plan change:

  - **customerId** — required.
  - **newPlan** — required, one of: starter | pro | enterprise.
  - **effectiveImmediately** — required boolean (true if they said "now"/"immediately"; otherwise false).

If any are missing, ask for them naturally in ONE short sentence.`,
	schema: v.object({
		customerId: v.string(),
		newPlan: v.picklist(['starter', 'pro', 'enterprise']),
		effectiveImmediately: v.boolean(),
	}),
	requiredFields: ['customerId', 'newPlan', 'effectiveImmediately'],
	async onComplete({ customerId, newPlan, effectiveImmediately }, ctx) {
		ctx.state.customerId = customerId;
		ctx.state.newPlan = newPlan;
		ctx.state.effectiveImmediately = effectiveImmediately;
		return { kind: 'node', node: askConfirmChange };
	},
});

function defineAskConfirmChange() {
	return defineReplyNode({
		name: 'ask-confirm-change',
		prompt: (ctx) => {
			const s = ctx.state as {
				customerId: string;
				newPlan: string;
				effectiveImmediately: boolean;
			};
			const effective = s.effectiveImmediately ? 'today' : 'at your next renewal';
			return `Confirm the plan change with the customer. 2 sentences, plain prose. MUST contain "${s.newPlan}" AND "${effective}". End with a yes/no ask.

Example: "I'll change account ${s.customerId} to the ${s.newPlan} plan, effective ${effective}. Shall I confirm?"`;
		},
		next: () => ({ kind: 'node', node: captureConfirmChange }),
	});
}
askConfirmChange = defineAskConfirmChange();

function defineCaptureConfirmChange() {
	return defineCaptureNode({
		name: 'capture-confirm-change',
		prompt: `The customer's last message is a reply to the plan-change confirmation. Classify confirmed (true) or declined / ambiguous (false). Emit ONLY the structured result.`,
		schema: v.object({ confirmed: v.boolean() }),
		async handler({ confirmed }, _ctx) {
			if (!confirmed) return { kind: 'node', node: changeCancelled };
			return { kind: 'node', node: applyChange };
		},
	});
}
captureConfirmChange = defineCaptureConfirmChange();

function defineApplyChange() {
	return defineComputeNode({
		name: 'apply-change',
		async compute(ctx) {
			const effective = ctx.state.effectiveImmediately
				? new Date().toISOString().slice(0, 10)
				: 'next-renewal';
			ctx.state.effectiveDate = effective;
			return { kind: 'node', node: changeDone };
		},
	});
}
applyChange = defineApplyChange();

function defineChangeDone() {
	return defineReplyNode({
		name: 'change-done',
		prompt: (ctx) => {
			const s = ctx.state as {
				customerId: string;
				newPlan: string;
				effectiveDate: string;
			};
			return `Confirm the plan change is applied. ONE sentence, plain prose. MUST contain "${s.newPlan}" AND "${s.effectiveDate}".

Example: "Done — account ${s.customerId} is now on the ${s.newPlan} plan, effective ${s.effectiveDate}."`;
		},
		next: { kind: 'end', reason: 'plan change applied' },
	});
}
changeDone = defineChangeDone();

function defineChangeCancelled() {
	return defineReplyNode({
		name: 'change-cancelled',
		prompt: `Acknowledge that the plan change was NOT applied. ONE short sentence.`,
		next: { kind: 'end', reason: 'plan change cancelled' },
	});
}
changeCancelled = defineChangeCancelled();

export const accountChangeFlow = defineFlow({
	name: 'account-change',
	description:
		'Plan changes (upgrade/downgrade), seat additions. Triggered when an existing customer wants to change their subscription tier.',
	startNode: () => collectChange,
});
