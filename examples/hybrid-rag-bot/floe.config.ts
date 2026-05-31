/**
 * Hybrid RAG example.
 *
 *   - HybridKnowledgeSource: BM25 + OpenAI embeddings + InMemoryVectorStore
 *     + strong-signal short-circuit (qmd defaults).
 *   - Heading-scored chunker.
 *   - Single Assistant, mode='direct' — keeps path pre-LLM-only so TTFT
 *     reflects retrieval cost, not routing.
 */
import { Assistant } from '@floe/runtime';
import { localSandbox } from '@floe/runtime/sandbox/local';
import { hybridKnowledge } from '@floe/runtime/knowledge/hybrid';
import { openaiEmbedder } from '@floe/runtime/embedders/openai';
import { InMemoryVectorStore } from '@floe/runtime/vectorstores';

const apiKey =
	process.env.OPENAI_API_KEY ?? (() => { throw new Error('OPENAI_API_KEY missing'); })();

const embedder = openaiEmbedder({
	apiKey,
	model: 'text-embedding-3-small',
	dimensions: 256,
});

const vectorStore = new InMemoryVectorStore({ dimensions: 256 });

export const faq = new Assistant({
	name: 'support',
	mode: 'direct',
	systemPrompt: `You are an Acme product assistant. Answer questions concisely (1-3 sentences) using ONLY the reference chunks under "# Reference material". If the chunks do not contain the answer, say "I don't have that information" and suggest contacting support. Cite chunks by bracket number when stating specifics (e.g. [1]).`,
	model: process.env.FLOE_MODEL ?? 'google/gemini-3.5-flash',
	thinkingLevel: 'off',
	sandbox: localSandbox(),
	knowledge: [
		hybridKnowledge({
			name: 'help-center-hybrid',
			paths: ['knowledge/**/*.md'],
			embedder,
			vectorStore,
			minChunkSize: 40,
			chunkSize: 600,
		}),
	],
});

export default faq;
