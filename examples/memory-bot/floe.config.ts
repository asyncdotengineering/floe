/**
 * Memory-bot — cross-session memory enabled.
 *
 * Generic concierge Assistant. The interesting bit:
 *   - `memory.service` — an in-process MemoryService
 *   - `resolveUserId(input)` — reads userId from `metadata.userId`;
 *     absence means memory is skipped (privacy default).
 */
import { Assistant } from '@floe/runtime';
import { localSandbox } from '@floe/runtime/sandbox/local';
import { InMemoryMemoryService } from '@floe/runtime/memory';

export const memoryService = new InMemoryMemoryService();

export const concierge = new Assistant({
	name: 'concierge',
	mode: 'direct',
	systemPrompt: `You are a friendly personal concierge. Keep replies brief (1-2 sentences). If you recall facts about the user from prior conversations (under "Context from Past Conversations"), weave them in naturally — do not list them. If asked what you remember and you have NO past-conversation context block, say honestly that you do not have any prior information about this user. Never fabricate preferences or facts.`,
	model: process.env.FLOE_MODEL ?? 'google/gemini-3.5-flash',
	thinkingLevel: 'off',
	sandbox: localSandbox(),
	memory: {
		service: memoryService,
		preload: { maxTokens: 600 },
		ingest: { auto: true, strategy: 'raw' },
	},
	resolveUserId: (input) => {
		if (input.type !== 'user_text_sent') return undefined;
		const userId = input.metadata?.userId;
		return typeof userId === 'string' && userId.length > 0 ? userId : undefined;
	},
});

export default concierge;
