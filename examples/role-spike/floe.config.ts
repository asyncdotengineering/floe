/**
 * role-spike — v1 BLUEPRINT canary. Verifies:
 *   1. `new Assistant({...})` constructs cleanly
 *   2. `mode: 'coordinate'` exposes `delegate` tool to host LLM
 *   3. Host LLM picks roles semantically (billing vs engineering)
 *   4. Child sessions don't hit the session-lock bug (delegate
 *      sidesteps Flue's broken `task` tool)
 *
 * Run:
 *   pnpm install   # one-time
 *   pnpm run spike # sends 2 messages, dumps conversation.md
 */
import { Assistant } from '@floe/runtime';
import { localSandbox } from '@floe/runtime/sandbox/local';

export const ops = new Assistant({
	name: 'spike',
	mode: 'coordinate',
	model: process.env.FLOE_MODEL ?? 'openai/gpt-4.1-mini',
	thinkingLevel: 'off',
	sandbox: localSandbox(),
	systemPrompt: `You are the front desk for Acme Corp.

You have two specialist roles available via the delegate() tool:
  • billing — pricing, invoices, refunds, plan changes
  • engineering — bugs, API errors, integrations, debugging

When a user asks something that clearly fits one specialist, delegate
via delegate({ role: '<name>', prompt: '<the user question>' }) and then
summarize the result for the user in one short sentence.

When unsure or when the question is conversational, answer directly
without delegating.

Keep your replies brief.`,
	roles: {
		billing: {
			name: 'billing',
			description: 'Billing specialist — pricing, refunds, invoices, plan changes',
			instructions: `You are a senior billing specialist at Acme. You
				speak plainly. Quote prices in USD per month per seat. Answer
				in one short paragraph. Never apologize. Never add filler.`,
		},
		engineering: {
			name: 'engineering',
			description: 'Engineering specialist — bugs, APIs, integrations, debugging',
			instructions: `You are a senior engineer at Acme. You diagnose API
				issues, suggest concrete debugging steps, and link to relevant
				docs when applicable. One short paragraph. Be specific —
				mention HTTP status codes, header names, retry semantics.`,
		},
	},
});

export default ops;
