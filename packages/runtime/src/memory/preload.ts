/**
 * Pre-LLM memory loader. The voice-safe pattern: NO extra LLM round-trip.
 *
 * Called by the orchestrator before prompt assembly. Searches memory using
 * the latest user message as the query, formats matching entries into a
 * markdown block, and returns it for injection into the system prompt.
 *
 * Token budget: hard cap on the returned markdown's estimated length.
 * Entries are added top-down (highest relevance first); we stop adding
 * when adding the next entry would exceed the budget. Empty result =>
 * returns `null` (caller should skip injection rather than emit an empty
 * section).
 */
import type { MemoryService } from './types.ts';

const CHARS_PER_TOKEN = 4; // matches what AriaFlow/Mastra also use as a coarse estimate

function estimateTokens(text: string): number {
	if (!text) return 0;
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface PreloadMemoryArgs {
	service: MemoryService;
	userId: string;
	userInput: string;
	/** Hard cap on tokens of the returned markdown block. Default 800. */
	maxTokens?: number;
	/** Max number of memories to consider (before token-budget trim). Default 10. */
	limit?: number;
	/** Optional filter passed through to the memory store. */
	filter?: Record<string, unknown>;
	/** Restrict to a single namespace. Omitted = search across all namespaces. */
	namespace?: string;
}

export async function preloadMemoryContext(
	args: PreloadMemoryArgs,
): Promise<string | null> {
	const maxTokens = args.maxTokens ?? 800;
	if (maxTokens <= 0) return null;

	const matches = await args.service.search({
		userId: args.userId,
		query: args.userInput,
		limit: args.limit ?? 10,
		...(args.filter ? { filter: args.filter } : {}),
		...(args.namespace !== undefined ? { namespace: args.namespace } : {}),
	});
	if (matches.length === 0) return null;

	const headerLines = [
		'## Context from Past Conversations',
		'',
		'You have spoken with this user before. Use the following remembered details to provide continuity and avoid asking for information they have already shared. Cite them naturally — never read them out as a list.',
		'',
	];
	const header = headerLines.join('\n');
	let used = estimateTokens(header);
	const includedLines: string[] = [];

	for (const m of matches) {
		const date = m.createdAt ? `[${m.createdAt.slice(0, 10)}] ` : '';
		const author = m.author ? `${m.author}: ` : '';
		const line = `- ${date}${author}${m.content}`;
		const cost = estimateTokens(line);
		if (used + cost > maxTokens) break;
		includedLines.push(line);
		used += cost;
	}

	if (includedLines.length === 0) return null;
	return header + includedLines.join('\n');
}
