/**
 * Acme Threads — Floe entrypoint.
 *
 * Single source of truth for the whole app. Imported by:
 *   - `server.ts`            — Node deployment via @hono/node-server
 *   - `api/[...all].ts`      — Vercel Edge deployment
 *   - `worker.ts`            — Cloudflare Worker deployment
 *
 * Folder convention used in this example:
 *   - `agents/`     — agent definitions (one per file)
 *   - `flows/`      — flow definitions (one per file)
 *   - `procedures/` — markdown policies + their TS wrappers
 *   - `knowledge/`  — RAG sources (markdown + chunkers)
 *   - `lib/`        — non-Floe shared modules (catalog, mock data, etc.)
 *
 * No `.flue/` directory, no codegen, no CLI required.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient as createLibsqlClient } from '@libsql/client';
import { Assistant } from '@floe/runtime';
import { conciergeSystemPrompt, conciergePersona } from './agents/concierge.ts';
import { localSandbox } from '@floe/runtime/sandbox/local';
import { hybridKnowledge } from '@floe/runtime/knowledge/hybrid';
import { openaiEmbedder } from '@floe/runtime/embedders/openai';
import { InMemoryVectorStore } from '@floe/runtime/vectorstores';
import { libSqlVectorStore } from '@floe/runtime/vectorstores/libsql';
import { VectorStoreMemoryService } from '@floe/runtime/memory';
import { piiRedaction, safety, groundedness } from '@floe/runtime/validators';
import { consoleSink } from '@floe/runtime/observability';

import { buildPurchaseFlow } from './flows/purchase.ts';
import { returnFlow } from './flows/return.ts';
import { trackOrderFlow } from './flows/track-order.ts';
import { returnPolicyProc } from './procedures/return-policy.ts';
import { escalationPolicyProc } from './procedures/escalation-policy.ts';
import { openCatalog } from './lib/catalog.ts';
import { productCatalogKnowledge } from './lib/product-knowledge.ts';


import { libsqlAssistantStateStore, libsqlSessionStore, libsqlTranscriptStore } from '@floe/state-libsql';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
	console.error('[ecommerce-bot] OPENAI_API_KEY required for embeddings.');
}

const embedderDimensions = 256;
const embedder = openaiEmbedder({
	apiKey: OPENAI_API_KEY ?? '',
	model: 'text-embedding-3-small',
	dimensions: embedderDimensions,
});

const catalog = await openCatalog(embedder);
const policyKnowledgeStore = new InMemoryVectorStore({ dimensions: embedderDimensions });

// State (sessions + memory) lives in a separate Turso DB so it's durable
// across Vercel cold starts and instance changes. Without this, both stores
// would live in Lambda RAM and be lost on every redeploy / eviction.
const STATE_TURSO_URL = process.env.STATE_TURSO_URL;
const STATE_TURSO_AUTH_TOKEN = process.env.STATE_TURSO_AUTH_TOKEN;
const stateClient = STATE_TURSO_URL
	? createLibsqlClient({ url: STATE_TURSO_URL, authToken: STATE_TURSO_AUTH_TOKEN })
	: undefined;

const memoryStore = stateClient
	? libSqlVectorStore({
			client: stateClient,
			dimensions: embedderDimensions,
			tableName: 'memory_vectors',
		})
	: new InMemoryVectorStore({ dimensions: embedderDimensions });

const sessionStore = STATE_TURSO_URL
	? libsqlSessionStore({ url: STATE_TURSO_URL, authToken: STATE_TURSO_AUTH_TOKEN })
	: undefined;

// Floe's per-assistant auxiliary state (turnCount, activeFlow, ...).
// Without a durable store, this lives in Lambda RAM and resets on
// every cold start — breaking mid-flow continuation.
const assistantStateStoreVal = STATE_TURSO_URL
	? libsqlAssistantStateStore({ url: STATE_TURSO_URL, authToken: STATE_TURSO_AUTH_TOKEN })
	: undefined;

// Clean, user-renderable transcript (AI-SDK UIMessage shape). Powers
// GET /history/:sessionId and GET /history/user/:userId.
const transcriptStore = STATE_TURSO_URL
	? libsqlTranscriptStore({ url: STATE_TURSO_URL, authToken: STATE_TURSO_AUTH_TOKEN })
	: undefined;

const memoryService = new VectorStoreMemoryService({
	embedder,
	vectorStore: memoryStore,
	namespace: 'acme-threads',
});

const purchaseFlow = buildPurchaseFlow(catalog);

// Workspace root for file-resolution. Bundlers (esbuild on Vercel) inline
// this config file INTO a different output path, so `import.meta.url`
// can't be trusted as the project-root signal in bundled deploys. The
// entry that triggered the bundle (e.g. api/build-entry.ts) sets
// FLOE_WORKSPACE_ROOT before importing this file; we honor it when set.
const configDir =
	process.env.FLOE_WORKSPACE_ROOT ?? dirname(fileURLToPath(import.meta.url));

export const supportAssistant = new Assistant({
	name: 'support',
	mode: 'direct',
	configDir,
	model: process.env.FLOE_MODEL ?? 'google/gemini-3.5-flash',
	thinkingLevel: (process.env.FLOE_THINKING as 'off' | 'low' | 'medium' | undefined) ?? 'low',
	sandbox: localSandbox(),
	state: {
		...(sessionStore ? { sessionStore } : {}),
		...(assistantStateStoreVal ? { assistantStateStore: assistantStateStoreVal } : {}),
		...(transcriptStore ? { transcriptStore } : {}),
	},
	memory: {
		service: memoryService,
		preload: { maxTokens: 600, namespace: 'preferences' },
		ingest: { auto: true, namespace: 'preferences' },
	},
	observability: { sinks: [consoleSink({ format: 'pretty' })] },
	systemPrompt: conciergeSystemPrompt,
	persona: conciergePersona,
	flows: [purchaseFlow, returnFlow, trackOrderFlow],
	procedures: [returnPolicyProc, escalationPolicyProc],
	// Knowledge is always retrieved (agents.md pattern). The runtime
	// injects chunks into the system prompt with explicit "use OR ignore"
	// rules — the LLM decides per turn whether the chunks are relevant.
	// See prompt-build.ts and docs/LATENCY.md.
	knowledge: [
		productCatalogKnowledge({ catalog, limit: 4 }),
		hybridKnowledge({
			name: 'policies-kb',
			paths: ['knowledge/policies/**/*.md', 'knowledge/faqs/**/*.md'],
			embedder,
			vectorStore: policyKnowledgeStore,
			chunkSize: 700,
			minChunkSize: 60,
		}),
	],
	validators: [
		piiRedaction({ phase: 'preLLM', strategy: 'mask' }),
		// `safety` defaults to `postLLM-async` so it runs as a side channel
		// after the response stream closes. Verdicts land on the
		// observability sink; the user-facing latency is unaffected.
		safety(),
		groundedness(),
	],
	resolveUserId(input) {
		if (input.type !== 'user_text_sent') return undefined;
		const u = input.metadata?.userId;
		return typeof u === 'string' && u.length > 0 ? u : undefined;
	},
	// Buffer-words prelude: emitted as the FIRST content delta on the wire
	// before retrieval / LLM kick off, so the user perceives ~10 ms TTFT.
	// TTS speaks "Got it — one sec…" while RAG embeds and the LLM TTFT
	// lands; the real reply appends as the next deltas. One continuous
	// stream from the consumer's perspective. See docs/LATENCY.md.
	//
	// A thunk would let us call a fast model for a contextual filler
	// ("Let me check on order ord_2240…") — see the `prelude` JSDoc on
	// AssistantConfig for that pattern. The static string here is the
	// cheapest, lowest-latency form and is plenty for the demo.
	prelude: 'Got it — one sec… ',
});

export default supportAssistant;
