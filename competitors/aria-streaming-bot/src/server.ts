/**
 * AriaFlow competitor server.
 *
 * Same workload as @floe/example-streaming-bot:
 *   - Single agent (faq)
 *   - RAG-style knowledge from knowledge/*.md (baked into the system prompt
 *     up-front since AriaFlow has no built-in retrieval; this matches what
 *     Floe ends up doing after BM25 retrieves chunks — facts in the prompt)
 *   - Streams via runtime.stream(); measures TTFT off the first text-delta
 *
 * Response shape matches Floe's web-chat channel JSON so the bench harness
 * can hit either server and parse the same fields:
 *
 *   {
 *     result: {
 *       text: string,
 *       stream: { ttftMs, endToEndMs, deltaCount, deltaBytes, streamingObserved }
 *     }
 *   }
 *
 * The framework's only fairness ask: choose the same model and feed it the
 * same factual context. Both sides do exactly that here.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runtime, type LLMAgentConfig } from '@ariaflowagents/core';
import {
	AiSdkEmbedder,
	InMemoryVectorStore,
	RagPipeline,
	createMarkdownChunker,
	type Document,
} from '@ariaflowagents/rag';
import { createVectorRetrievalTool } from '@ariaflowagents/tools';
import { openai } from '@ai-sdk/openai';
import { google } from '@ai-sdk/google';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = resolve(__dirname, '..', 'knowledge');
const PORT = Number(process.env.PORT ?? 3597);

function loadKnowledge(): string {
	const files = readdirSync(KNOWLEDGE_DIR)
		.filter((f) => f.endsWith('.md'))
		.sort();
	return files
		.map((f) => `--- ${f} ---\n${readFileSync(resolve(KNOWLEDGE_DIR, f), 'utf8')}`)
		.join('\n\n');
}

function resolveModel(modelId: string) {
	// AriaFlow takes ai-sdk Model objects, not pi-ai style 'provider/model'
	// strings. Translate.
	const [provider, ...rest] = modelId.split('/');
	const name = rest.join('/');
	if (provider === 'openai') return openai(name);
	if (provider === 'google') return google(name);
	throw new Error(`Unsupported model provider: ${provider}`);
}

const MODEL_ID = process.env.BENCH_MODEL ?? 'openai/gpt-4o-mini';
const MODE = (process.env.BENCH_MODE ?? 'stuffed') as 'stuffed' | 'rag';

async function buildAgent(): Promise<LLMAgentConfig> {
	if (MODE === 'rag') {
		// Real AriaFlow RAG: agent calls a vector-retrieval tool. Adds one
		// extra LLM hop (tool call) + one embedding call + vector search.
		// More representative of how AriaFlow apps actually do retrieval.
		const embedder = new AiSdkEmbedder({
			model: openai.embedding('text-embedding-3-small'),
		});
		const chunker = createMarkdownChunker({ maxChars: 800, overlapChars: 80 });
		const vectorStore = new InMemoryVectorStore();
		const ragPipeline = new RagPipeline({
			embedder,
			vectorStore,
			chunker,
			indexName: 'acme-kb',
		});
		const knowledgeDir = KNOWLEDGE_DIR;
		const files = readdirSync(knowledgeDir).filter((f) => f.endsWith('.md')).sort();
		const docs: Document[] = files.map((f) => ({
			id: f,
			text: readFileSync(resolve(knowledgeDir, f), 'utf8'),
			metadata: { source: f },
		}));
		await ragPipeline.ingest(docs);
		console.error(`[aria-server] ingested ${docs.length} docs into vector store`);
		const searchTool = createVectorRetrievalTool({
			retriever: ragPipeline,
			topK: 5,
		});
		return {
			id: 'faq',
			name: 'Acme FAQ (RAG)',
			type: 'llm',
			description: 'Answers Acme questions via vector retrieval.',
			prompt: `You are an Acme product assistant. Before answering any factual question (pricing, features, integrations, data residency), CALL the search_knowledge tool first to retrieve relevant material. Then answer concisely in 2-4 sentences, grounded in the retrieved chunks. If retrieval returns nothing relevant, say you do not have that information.`,
			model: resolveModel(MODEL_ID) as any,
			tools: { search_knowledge: searchTool },
		};
	}
	// Default: knowledge stuffed into the prompt — fastest, no retrieval hop.
	const knowledge = loadKnowledge();
	return {
		id: 'faq',
		name: 'Acme FAQ',
		type: 'llm',
		description: 'Answers Acme questions from a baked-in knowledge base.',
		prompt: `You are an Acme product assistant. Answer questions concisely (2-4 sentences) using ONLY the reference material below. If the material does not contain the answer, say you do not have that information.

REFERENCE MATERIAL:
${knowledge}`,
		model: resolveModel(MODEL_ID) as any,
		tools: {},
	};
}

const faqAgent = await buildAgent();

const runtime = new Runtime({
	agents: [faqAgent],
	defaultAgentId: faqAgent.id,
	defaultModel: faqAgent.model,
	// Do NOT enable any sinks — we want pure framework cost, no I/O.
});

interface RunResult {
	text: string;
	ttftMs: number | null;
	endToEndMs: number;
	deltaCount: number;
	deltaBytes: number;
	streamingObserved: boolean;
}

async function runTurn(input: string, sessionId?: string): Promise<RunResult & { sessionId?: string }> {
	const startedAt = Date.now();
	let firstDeltaAt: number | null = null;
	let deltaCount = 0;
	let deltaBytes = 0;
	let text = '';
	let outSession: string | undefined = sessionId;
	for await (const part of runtime.stream({ input, sessionId })) {
		if (part.type === 'text-delta') {
			deltaCount += 1;
			deltaBytes += part.text.length;
			text += part.text;
			if (firstDeltaAt === null) firstDeltaAt = Date.now();
		} else if (part.type === 'done') {
			outSession = part.sessionId;
		}
	}
	const endedAt = Date.now();
	return {
		text,
		ttftMs: firstDeltaAt !== null ? firstDeltaAt - startedAt : null,
		endToEndMs: endedAt - startedAt,
		deltaCount,
		deltaBytes,
		streamingObserved: deltaCount > 0,
		sessionId: outSession,
	};
}

function send(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const raw = Buffer.concat(chunks).toString('utf8');
	return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

const server = createServer(async (req, res) => {
	try {
		if (req.method === 'GET' && req.url === '/') {
			return send(res, 200, { ok: true, framework: 'ariaflow', model: MODEL_ID, mode: MODE });
		}
		// Match Floe's URL shape: POST /agents/web/<id>
		if (req.method === 'POST' && req.url?.startsWith('/agents/web/')) {
			const sessionId = req.url.slice('/agents/web/'.length) || undefined;
			const body = await readJson(req);
			const message = String(body.message ?? '');
			const result = await runTurn(message, sessionId);
			return send(res, 200, {
				result: {
					text: result.text,
					events: [],
					stream: {
						ttftMs: result.ttftMs,
						endToEndMs: result.endToEndMs,
						deltaCount: result.deltaCount,
						deltaBytes: result.deltaBytes,
						streamingObserved: result.streamingObserved,
					},
				},
			});
		}
		send(res, 404, { error: 'not_found' });
	} catch (err) {
		console.error('[aria-server] error:', err);
		send(res, 500, { error: err instanceof Error ? err.message : String(err) });
	}
});

server.listen(PORT, () => {
	console.error(`[aria-server] listening on http://localhost:${PORT}  model=${MODEL_ID}  mode=${MODE}`);
});
