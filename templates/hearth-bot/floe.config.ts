/**
 * Hearth-bot Assistant config — B2C meal-kit subscription support.
 *
 * Channels: web widget (Floe-aware) + voice (via @floe/adapter-voice).
 * Specialist roles: `retention` (cancellation flow), `box-issue`
 * (damaged/missing/spoiled). Mode `coordinate` so the host can
 * delegate via task().
 *
 * MCP: Subscription + Order, mocked via @floe/mock-services.
 *
 * Memory: keyed by `subscriberId` (resolved from inbound metadata).
 * Subscribers calling from voice should be resolved by the gateway
 * (phone number → subscriberId lookup) BEFORE the turn lands here.
 */
import { Assistant } from '@floe/runtime';
import { localSandbox } from '@floe/runtime/sandbox/local';
import { workspaceBm25 } from '@floe/runtime/knowledge/workspace-bm25';
import { safety } from '@floe/runtime/validators';
import { InMemoryMemoryService } from '@floe/runtime/memory';
import { mountAllMocks, type MountedMocks } from './mocks.ts';

export async function createHearthBot(): Promise<{
	assistant: Assistant;
	mocks: MountedMocks;
}> {
	const mocks = await mountAllMocks();

	const assistant = new Assistant({
		name: 'hearth-bot',
		mode: 'coordinate',
		model: process.env.FLOE_MODEL ?? 'openai/gpt-4.1-mini',
		sandbox: localSandbox(),
		configDir: import.meta.dirname,

		systemPrompt: `You are Hearth's subscription assistant for meal-kit
customers. Help with skip-week, address changes, pause, cancel, and
box issues.

OPERATING RULES:
- Always ACT FIRST via a tool, then confirm in one short sentence.
- Never promise a refund without calling mcp__subscription__issue_refund.
- Never quote refund amounts from memory — check the retrieved
  knowledge chunks (the refund matrix).
- When the user is cancelling, delegate to the 'retention' role
  via task({ role: 'retention' }).
- When the user reports a box issue (damaged/missing/spoiled),
  delegate to the 'box-issue' role.
- If the caller says "speak to a human" or sounds upset and
  unhappy with your handling, escalate.

Available tools:
- mcp__subscription__* (lookup_subscription, skip_week, pause_subscription,
  cancel_subscription, update_address, issue_refund)
- mcp__order__* (lookup_order, list_orders_by_user, report_issue)`,

		roles: {
			retention: {
				name: 'retention',
				description:
					'Handles cancellation attempts. Make ONE empathetic acknowledgement then ONE offer based on tenure + reason.',
				instructions: `You are Hearth's retention specialist. The
customer is cancelling.

RULES:
- ONE empathetic acknowledgement, then ONE relevant offer.
- Never beg, never offer more than one alternative.
- Tenure-based offers (check lookup_subscription for tenure):
  - < 3 months: "skip the next 2 weeks at no cost"
  - 3-12 months: "pause for 2 weeks" or "switch to a smaller plan"
  - 12+ months: honor the cancel quietly + note the reason
- If the customer says "just cancel" explicitly, cancel without an offer.
- DO NOT use task() — you ARE the specialist; reply directly.`,
				thinkingLevel: 'high',
			},
			'box-issue': {
				name: 'box-issue',
				description:
					'Handles damaged/missing/spoiled boxes. Cap credit at $50 without escalation.',
				instructions: `You handle box issues — damaged, missing, or
spoiled deliveries.

RULES:
- Ask what was wrong (one short question).
- File the issue via mcp__order__report_issue.
- Use the refund matrix (in the retrieved knowledge) to decide credit
  vs reship.
- CAP credit at $50 without escalation. Above $50, say "I'll get a
  retention specialist to handle this" and end the turn.
- DO NOT use task() — you ARE the specialist; reply directly.`,
			},
		},

		mcp: [
			{ name: mocks.subscription.name, url: mocks.subscription.url },
			{ name: mocks.order.name, url: mocks.order.url },
		],

		knowledge: [
			workspaceBm25({
				name: 'hearth-policies',
				paths: ['knowledge/**/*.md'],
				chunkSize: 600,
			}),
		],

		validators: [
			safety({ phase: 'postLLM' }),
		],

		memory: {
			service: new InMemoryMemoryService(),
			preload: { maxTokens: 600 },
			ingest: { auto: true, strategy: 'extract' },
		},

		resolveUserId(input) {
			const meta = input.metadata as { subscriberId?: string; userId?: string } | undefined;
			return meta?.subscriberId ?? meta?.userId;
		},

		compaction: { reserveTokens: 8000, keepRecentTokens: 4000 },
	});

	return { assistant, mocks };
}
