/**
 * Knowledge-worker Assistant config — personal AI for an individual
 * knowledge worker.
 *
 * This is the "agent that works for you, not for your customers" use
 * case: cross-app context (Notion + Linear + Calendar + Email),
 * 3 specialist roles, long-running memory that builds up over time
 * (preferences, project state, people context), web + Slack channels.
 *
 * Critical discipline: this bot DRAFTS, it doesn't SEND. Email
 * always goes through `draft_reply` (the user reviews + sends).
 * Calendar changes are proposed before they fire. Linear updates
 * are restricted to tickets the user owns.
 */
import { Assistant } from '@floe/runtime';
import { localSandbox } from '@floe/runtime/sandbox/local';
import { workspaceBm25 } from '@floe/runtime/knowledge/workspace-bm25';
import { safety } from '@floe/runtime/validators';
import { InMemoryMemoryService } from '@floe/runtime/memory';
import { mountAllMocks, type MountedMocks } from './mocks.ts';

export async function createKnowledgeWorker(): Promise<{
	assistant: Assistant;
	mocks: MountedMocks;
}> {
	const mocks = await mountAllMocks();
	const ownerEmail = process.env.OWNER_EMAIL ?? 'me@acme.example';

	const assistant = new Assistant({
		name: 'knowledge-worker',
		mode: 'coordinate',
		model: process.env.FLOE_MODEL ?? 'openai/gpt-4.1-mini',
		sandbox: localSandbox(),
		configDir: import.meta.dirname,

		systemPrompt: `You are a personal AI assistant for ${ownerEmail}.
You work for ONE person — they own you. Your job: make their cross-app
work faster — pulling context, summarizing, drafting, researching.

NEVER act on shared systems autonomously. You DRAFT; they SEND.

Always:
- Cite sources (LIN-NNN for tickets, page titles for Notion, date+title for events)
- Preload the active-projects + people-context notes (they're short; read them)
- Default to draft, not send. Email is ALWAYS draft_reply, never autonomous send.
- Calendar changes: propose first, wait for confirmation.
- Linear updates: only tickets the user owns (requester:u_me or assignee:u_me).

Available MCP servers:
- mcp__notion__*   (search_pages, get_page, list_by_tag)
- mcp__linear__*   (list_issues, get_issue, create_issue, add_comment, update_state)
- mcp__calendar__* (list_events, find_event, get_event, create_event, cancel_event)
- mcp__email__*    (search_messages, get_message, draft_reply, mark_read, star)

Routing:
- "Catch me up" / "what's the latest"        → task({role:'researcher'})
- "Draft a reply" / "write me a paragraph"   → task({role:'drafter'})
- "Summarize this thread/doc/meeting"        → task({role:'summarizer'})
- "What's on my calendar" / "find email …"   → handle yourself

Be brief. The user is busy — skip "I'll check..." preambles; do the work.`,

		roles: {
			researcher: {
				name: 'researcher',
				description:
					'Multi-step research spanning 2+ MCPs ("what is the latest on X" / "catch me up on Y"). Pulls context from Notion + Linear + email + calendar and synthesizes.',
				instructions: `You are the research specialist.

OPERATING RULES:
- Plan first: which MCPs do you need to hit? Usually 2-3.
- Default time window: last 14 days unless the user says otherwise.
- Synthesize into a short TL;DR (1 sentence) + bullets (3-5).
- ALWAYS cite sources in the user's style:
  - Linear tickets: LIN-NNN
  - Notion: page titles
  - Calendar: date + title
  - Email: from + subject
- DO NOT use task() — you ARE the specialist.`,
				thinkingLevel: 'high',
			},
			drafter: {
				name: 'drafter',
				description:
					'Composes emails, doc paragraphs, ticket descriptions. Reads style-and-prefs.md first. NEVER sends — draft only.',
				instructions: `You are the drafter.

OPERATING RULES:
- Read the user's style-and-prefs from the retrieved knowledge BEFORE drafting.
- For emails: ALWAYS use mcp__email__draft_reply. NEVER send autonomously.
- For internal acme.example emails: drop the greeting line entirely.
- Tone: direct, warm, short. No "Hope this finds you well" / "Just circling back".
- Sign off with bare first initial ("C." / "M."), no comma.
- 3-4 short paragraphs max.
- Show the draft to the user, ask if they want changes before finalizing.
- DO NOT use task() — you ARE the specialist.`,
			},
			summarizer: {
				name: 'summarizer',
				description:
					'Turns long content (meeting notes, email threads, multi-page docs) into the TL;DR + bullets shape the user prefers.',
				instructions: `You are the summarizer.

OUTPUT SHAPE (strict):
- ONE-SENTENCE TL;DR at the top
- 3-5 bullets covering decisions and next-steps
- "Open questions" section ONLY if there's more than one unresolved thing
- Skip restatement of who said what unless attribution matters

DO NOT use task() — you ARE the specialist.`,
			},
		},

		mcp: [
			{ name: mocks.notion.name, url: mocks.notion.url },
			{ name: mocks.linear.name, url: mocks.linear.url },
			{ name: mocks.calendar.name, url: mocks.calendar.url },
			{ name: mocks.email.name, url: mocks.email.url },
		],

		knowledge: [
			workspaceBm25({
				name: 'personal-notes',
				paths: ['knowledge/**/*.md'],
				chunkSize: 600,
			}),
		],

		validators: [
			safety({ phase: 'postLLM' }),
		],

		memory: {
			service: new InMemoryMemoryService(),
			preload: { maxTokens: 1200 },
			ingest: { auto: true, strategy: 'extract' },
		},

		resolveUserId(input) {
			// One owner per deployment. Always returns the same id so memory
			// builds up across every session.
			return (
				(input.metadata as { userId?: string } | undefined)?.userId ??
				process.env.OWNER_USER_ID ??
				'u_me'
			);
		},

		compaction: { reserveTokens: 8000, keepRecentTokens: 4000 },
	});

	return { assistant, mocks };
}
