/**
 * Streaming-bot — minimal single-Assistant path that exercises real streaming.
 *
 * Lower-bound TTFT for a Floe Assistant: no triage call, no flows,
 * just one prompt() + retrieval. The live bench verifies that text_delta
 * events actually fire and that real TTFT < server end-to-end.
 */
import { Assistant } from '@floe/runtime';
import { localSandbox } from '@floe/runtime/sandbox/local';
import { workspaceBm25 } from '@floe/runtime/knowledge/workspace-bm25';

export const faq = new Assistant({
	name: 'faq',
	mode: 'direct',
	systemPrompt: `You are an Acme product assistant. Answer questions concisely (2-4 sentences) using the reference chunks. If the chunks do not contain the answer, say you do not have that information and suggest contacting support. Cite by bracket number when stating a specific fact.`,
	model: process.env.FLOE_MODEL ?? 'google/gemini-3.5-flash',
	thinkingLevel: 'off',
	sandbox: localSandbox(),
	knowledge: [
		workspaceBm25({
			name: 'help-center',
			paths: ['knowledge/**/*.md'],
			chunkSize: 400,
			minChunkSize: 40,
		}),
	],
});

export default faq;
