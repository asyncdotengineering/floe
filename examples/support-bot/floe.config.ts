/**
 * Support-bot — multi-role Assistant (the v1 BLUEPRINT make-or-break example).
 *
 * One Assistant, mode='coordinate', two specialist roles (service,
 * sales). The host LLM delegates via the delegate() tool when a user
 * question fits a specialist domain. Three flows (refund, signup,
 * account-change) attach at the Assistant level. Three procedures
 * (refund/escalation/tone) inject policy silently.
 *
 * Channels: web only (slack + voice deleted in v1 — adapters become
 * separate packages in a follow-up).
 */
import { Assistant, defineTool } from '@floe/runtime';
import { localSandbox } from '@floe/runtime/sandbox/local';
import { workspaceBm25 } from '@floe/runtime/knowledge/workspace-bm25';
import { groundedness, safety } from '@floe/runtime/validators';
import * as v from 'valibot';

import { refundFlow } from './flows/refund.ts';
import { signupFlow } from './flows/signup.ts';
import { accountChangeFlow } from './flows/account-change.ts';
import { refundPolicyProc } from './procedures/refund-policy.ts';
import { escalationPolicyProc } from './procedures/escalation-policy.ts';
import { tonePolicyProc } from './procedures/tone-policy.ts';

// ─── Shared tools (available to host + both roles via delegate) ─────────────

const lookupAccount = defineTool({
	name: 'lookupAccount',
	description:
		'Look up an Acme account by email or customer id. Returns plan tier, status, and recent invoices.',
	parameters: v.object({ identifier: v.string() }),
	interim: 'One moment while I pull up your account...',
	async execute({ identifier }) {
		const id = String(identifier);
		if (id.toLowerCase() === 'alice@acme.example') {
			return {
				email: 'alice@acme.example',
				customerId: 'cus_001',
				plan: 'pro',
				status: 'active',
				renewsOn: '2026-08-12',
				lastInvoice: { id: 'inv_881', amountUsd: 89, paidOn: '2026-04-12' },
			};
		}
		if (id.toLowerCase() === 'bob@example.com') {
			return {
				email: 'bob@example.com',
				customerId: 'cus_002',
				plan: 'starter',
				status: 'past_due',
				renewsOn: '2026-06-01',
				lastInvoice: { id: 'inv_902', amountUsd: 19, paidOn: null },
			};
		}
		return { error: 'no_account_found', hint: 'Verify the email or escalate to a human.' };
	},
});

const checkSubscriptionStatus = defineTool({
	name: 'checkSubscriptionStatus',
	description: 'Quick check of current plan + billing status for a known customer id.',
	parameters: v.object({ customerId: v.string() }),
	async execute({ customerId }) {
		const cid = String(customerId);
		const known: Record<string, { plan: string; status: string }> = {
			cus_001: { plan: 'pro', status: 'active' },
			cus_002: { plan: 'starter', status: 'past_due' },
		};
		return known[cid] ?? { error: 'unknown_customer_id' };
	},
});

const checkPlanPricing = defineTool({
	name: 'checkPlanPricing',
	description: 'Get current Acme plan pricing and feature comparison.',
	parameters: v.object({ region: v.optional(v.picklist(['us', 'eu', 'apac'])) }),
	async execute() {
		return {
			plans: [
				{ id: 'starter', name: 'Starter', priceMonthlyUsd: 19, seats: 3, features: ['core', 'email-support'] },
				{ id: 'pro', name: 'Pro', priceMonthlyUsd: 89, seats: 15, features: ['core', 'workflows', 'integrations', 'priority-support'] },
				{ id: 'enterprise', name: 'Enterprise', priceMonthlyUsd: null, seats: 'unlimited', features: ['everything', 'sso', 'sla', 'dedicated-csm'] },
			],
		};
	},
});

const bookDemo = defineTool({
	name: 'bookDemo',
	description: 'Schedule a 30-minute product demo. Requires the prospect email and a preferred time window.',
	parameters: v.object({
		email: v.string(),
		preferredWindow: v.string(),
		companyName: v.optional(v.string()),
	}),
	async execute({ email, preferredWindow, companyName }) {
		return {
			demoId: `demo_${Math.random().toString(36).slice(2, 10)}`,
			email,
			scheduled: 'pending-confirmation',
			window: preferredWindow,
			company: companyName ?? null,
			confirmationEmailQueued: true,
		};
	},
});

// ─── The Assistant ─────────────────────────────────────────────────────────

export const supportAssistant = new Assistant({
	name: 'support',
	mode: 'coordinate',
	model: process.env.FLOE_MODEL ?? 'google/gemini-3.5-flash',
	thinkingLevel: 'low',
	sandbox: localSandbox(),
	compaction: { reserveTokens: 8000, keepRecentTokens: 4000 },
	systemPrompt: `You are the front desk for Acme support. You handle two domains:

  - SERVICE — existing customer issues: billing, account changes, refunds,
    password resets, troubleshooting. Delegate via delegate({role: 'service'}).
  - SALES — pre-sales: pricing, plan comparisons, demos, signup. Delegate
    via delegate({role: 'sales'}).

When the user's question clearly fits one specialist, delegate to them via
the delegate() tool. When it's a quick acknowledgment or unclear, answer
directly. Keep replies brief (1-2 sentences for the host; the specialists
handle the meat).

Available tools (shared with both specialists via delegation):
- lookupAccount(identifier) — by email or customer id
- checkSubscriptionStatus(customerId) — current plan + billing status
- checkPlanPricing(region?) — current plans and pricing
- bookDemo(email, preferredWindow, companyName?) — schedule a demo`,
	roles: {
		service: {
			name: 'service',
			description:
				'Handles EXISTING-CUSTOMER support: billing problems, account changes, refunds, password resets, troubleshooting.',
			instructions: `You are Acme's customer-service specialist for EXISTING CUSTOMERS.

OPERATING RULES (strict):
- If the customer mentions an email or customer id, IMMEDIATELY call lookupAccount before anything else.
- Use checkSubscriptionStatus when you have a customer id.
- Never invent product features, prices, or policies. Use the help center references provided.
- Cite references by their bracket number, e.g. "Our refund window is 30 days [1]."
- Be warm, concise, direct. 2-4 sentences for chat, 1-2 for voice.
- If you don't know something, say so honestly.
- DO NOT use delegate() or task() — you ARE the specialist; respond directly with your answer.`,
		},
		sales: {
			name: 'sales',
			description:
				'Handles PRE-SALES: pricing, plan comparisons, demos, signup. For prospects evaluating Acme who are NOT yet customers.',
			instructions: `You are Acme's sales specialist for PROSPECTS evaluating Acme.

OPERATING RULES (strict):
- Always call checkPlanPricing before quoting any price — never recite from memory.
- Cite help-center references by their bracket number.
- Friendly, knowledgeable, never pushy. 2-4 sentences for chat, 1-2 for voice.
- Lead with discovery for evaluation questions: understand team size and use case before recommending.
- Offer to book a demo when the prospect mentions integrations, team size, or "how would this work for us."
- DO NOT use delegate() or task() — you ARE the specialist; respond directly with your answer.`,
		},
	},
	tools: [lookupAccount, checkSubscriptionStatus, checkPlanPricing, bookDemo],
	flows: [refundFlow, signupFlow, accountChangeFlow],
	procedures: [refundPolicyProc, escalationPolicyProc, tonePolicyProc],
	validators: [
		safety({ phase: 'postLLM' }),
		groundedness({ threshold: 0.55, escalateBelow: 0.3 }),
	],
	knowledge: [
		workspaceBm25({
			name: 'help-center',
			paths: ['knowledge/**/*.md'],
			chunkSize: 600,
		}),
	],
	// Opt in to citation guidance for the help-center references. The
	// streaming sanitizer (packages/runtime/src/streaming/citation-sanitizer.ts)
	// strips any hallucinated non-numeric bracket so the audit trail stays
	// clean even when gemini-3.5-flash tries to cite tool names.
	citations: 'optional',
});

export default supportAssistant;
