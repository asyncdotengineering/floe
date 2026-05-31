/**
 * Ops-bot Assistant config.
 *
 * Domain: internal IT/HR operations at Acme. Channels: Slack (primary)
 * + web. MCP servers: Okta + Notion + Linear, all mounted as in-process
 * mocks via @floe/mock-services so the template runs end-to-end with
 * `pnpm dev`. Knowledge: BM25 over the markdown in `knowledge/`.
 *
 * When you fork this template:
 *   1. Rewrite `systemPrompt` for your team's voice + scope.
 *   2. Edit `knowledge/policies/*.md` + `knowledge/runbooks/*.md` to
 *      match your real policies.
 *   3. Swap the mock-service mounts (in `mocks.ts`) for real MCP server
 *      URLs as you wire them up — one at a time. The assistant prompt
 *      doesn't care whether Okta is mocked or real.
 *   4. Set `LINEAR_API_KEY` etc in `.env` and remove the matching
 *      `mount<X>` calls.
 */
import { Assistant } from '@floe/runtime';
import { localSandbox } from '@floe/runtime/sandbox/local';
import { workspaceBm25 } from '@floe/runtime/knowledge/workspace-bm25';
import { safety } from '@floe/runtime/validators';
import { InMemoryMemoryService } from '@floe/runtime/memory';
import { consoleSink } from '@floe/runtime/observability';
import { mountAllMocks, type MountedMocks } from './mocks.ts';

/**
 * Mounts the 3 mock MCP servers and constructs the Assistant.
 * Returns both so `server.ts` can register the mock lifecycle on
 * shutdown via `runServer({ beforeListen })`.
 */
export async function createOpsBot(): Promise<{
	assistant: Assistant;
	mocks: MountedMocks;
}> {
	const mocks = await mountAllMocks();

	const assistant = new Assistant({
		name: 'ops-bot',
		model: process.env.FLOE_MODEL ?? 'openai/gpt-4.1-mini',
		sandbox: localSandbox(),
		configDir: import.meta.dirname,

		systemPrompt: `You are the IT operations bot for Acme. Help employees
with access requests, software, password issues, on-call escalations,
and policy questions.

ALWAYS file a Linear ticket when an action needs human approval —
never just acknowledge and forget. Cite policy by name when you
reference it. Keep replies short and direct (2-3 sentences).

Available MCP servers:
- mcp__okta__*  (lookup_user_by_email, check_group_membership, find_manager, list_group_members)
- mcp__notion__* (search_pages, get_page, list_by_tag)
- mcp__linear__* (create_issue, list_issues, get_issue, add_comment, update_state)

When in doubt, escalate by filing a ticket — don't make the call yourself.`,

		mcp: [
			{ name: mocks.okta.name, url: mocks.okta.url },
			{ name: mocks.notion.name, url: mocks.notion.url },
			{ name: mocks.linear.name, url: mocks.linear.url },
		],

		knowledge: [
			workspaceBm25({
				name: 'ops-knowledge',
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
			const meta = input.metadata as { slackUserId?: string; userId?: string } | undefined;
			return meta?.slackUserId ?? meta?.userId;
		},

		compaction: { reserveTokens: 8000, keepRecentTokens: 4000 },

		// Per-turn observability — one pretty-printed block per turn
		// to stderr so you can see latency stages, tokens, cost, models,
		// validator verdicts as the agent runs. Production should layer
		// a real sink (sentrySink / braintrustSink / otelSink) on top.
		observability: {
			sinks: [consoleSink({ format: 'pretty' })],
		},
	});

	return { assistant, mocks };
}
