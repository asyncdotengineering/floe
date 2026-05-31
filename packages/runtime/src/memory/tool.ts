/**
 * Opt-in LLM-callable memory tool.
 *
 * Use this when you want the agent to decide when to recall (e.g. mid-flow
 * "what did the user say about X last time?"). Costs one extra LLM
 * round-trip per call, so do NOT add this to voice agents — use
 * `preloadMemoryContext` for the pre-LLM path instead.
 *
 * The tool needs a MemoryService and a userId; Floe wires both in via
 * the agent's ToolContext when this is registered.
 */
import * as v from 'valibot';
import { defineTool } from '../define.ts';
import type { FloeTool, ToolContext } from '../types.ts';
import type { MemoryService } from './types.ts';

export interface LoadMemoryToolOptions {
	service: MemoryService;
	/** How to resolve the userId at call time. */
	resolveUserId: (ctx: ToolContext) => string | undefined;
	/** Max results returned to the model. Default 8. */
	limit?: number;
}

export function createLoadMemoryTool(opts: LoadMemoryToolOptions): FloeTool {
	return defineTool({
		name: 'load_memory',
		description:
			'Search long-term memory for relevant information about this user from past conversations. Call this when the user refers to something discussed previously, or when you need to recall their preferences / history.',
		parameters: v.object({
			query: v.pipe(
				v.string(),
				v.description('What to search for in past conversations.'),
			),
		}),
		async execute(args, ctx) {
			const query = String((args as { query: string }).query);
			const userId = opts.resolveUserId(ctx);
			if (!userId) {
				return { memories: [], note: 'No userId for this turn — memory disabled.' };
			}
			const entries = await opts.service.search({
				userId,
				query,
				limit: opts.limit ?? 8,
			});
			return {
				memories: entries.map((m) => ({
					content: m.content,
					author: m.author,
					createdAt: m.createdAt,
					score: m.score,
				})),
			};
		},
	});
}
