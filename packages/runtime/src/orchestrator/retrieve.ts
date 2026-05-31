/**
 * retrieve — stage 2: match procedures, retrieve knowledge, preload memory.
 *
 * Extracted from orchestrator.ts per REFACTOR-FIN-HARNESS §6 (C-7).
 * Steps: match procedures → knowledge retrieval → cross-session memory preload.
 */
import type { FlueSession } from '@flue/runtime';
import type {
	AssistantConfig,
	AssistantOutputEvent,
	KnowledgeChunk,
	KnowledgeSource,
	Procedure,
} from '../types.ts';
import { loadProcedure, matchesProcedure } from '../procedure-loader.ts';
import { formatActiveProceduresForState } from '../prompt-build.ts';
import type { MemoryCoordinator } from '../memory/coordinator.ts';
import type { TurnMetrics, TurnStageLatencies } from '../observability/types.ts';
import type { RetrieveOutput } from './types.ts';

export interface RetrieveArgs {
	session: FlueSession;
	convo: AssistantConfig;
	userMessage: string;
	events: AssistantOutputEvent[];
	respondingTo: string;
	/**
	 * Memory coordinator — owns the preload lifecycle. A no-op stub when
	 * memory isn't configured, so we never null-check at this layer.
	 */
	memory: MemoryCoordinator;
	userId: string | undefined;
	stages: TurnStageLatencies;
}

export async function retrieve(args: RetrieveArgs): Promise<RetrieveOutput> {
	const { session, convo, userMessage, events, respondingTo, memory, userId, stages } = args;
	const emit = (e: AssistantOutputEvent) => events.push(e);

	// 5. Match procedures. session.fs resolves relative paths against
	// the harness cwd, set in prepare-turn via ctx.init({cwd: convo.configDir}).
	const matchedProcedures = await matchProceduresForTurn({
		procedures: convo.procedures ?? [],
		session,
		userMessage,
	});
	for (const m of matchedProcedures) {
		emit({
			type: 'conversation_event',
			subtype: 'procedure_activated',
			data: { name: m.metadata.name, path: m.procedure.path },
			respondingTo,
		});
	}

	// 6. Knowledge retrieval. Always-on (agents.md pattern) — retrieved
	// chunks land in the system prompt with explicit relevance guidance,
	// and the LLM decides whether to cite them or say "I don't have
	// that." Skipping retrieval with a developer-written predicate
	// recreates the surface-form fragility we eliminated elsewhere
	// (regex on "size" vs "sizing", non-English, etc.). The way to cut
	// RAG latency is to make RETRIEVAL itself faster (smaller embedder
	// dims, kNN cache, speculative parallel fetch) — not to gate it.
	// See docs/LATENCY.md.
	const knowledgeStart = Date.now();
	let knowledgeChunks: KnowledgeChunk[] = [];
	const knowledgeUsage: TurnMetrics['knowledge'] = [];
	if (convo.knowledge && convo.knowledge.length > 0 && userMessage.trim().length > 0) {
		knowledgeChunks = await retrieveKnowledge(convo.knowledge, session, userMessage, emit, respondingTo);
		for (const k of convo.knowledge) {
			const fromThisSource = knowledgeChunks.filter((c) =>
				typeof (c.metadata as Record<string, unknown> | undefined)?.source === 'string'
					? false
					: c.source.startsWith(k.name) || true,
			);
			knowledgeUsage.push({ source: k.name, chunks: fromThisSource.length });
		}
	}
	stages.knowledgeMs = Date.now() - knowledgeStart;

	// 6b. Cross-session memory preload — coordinator handles userId
	// null-check, preload-disabled config, defaults, error swallowing.
	const preload = await memory.preload({ userId, userMessage });
	if (preload.context) {
		emit({
			type: 'conversation_event',
			subtype: 'memory_preloaded',
			data: { userId, charCount: preload.context.length },
			respondingTo,
		});
	}
	const memoryContext = preload.context;
	const memoryPreloadCount = preload.chunkCount;
	stages.memoryPreloadMs = preload.durationMs;

	return {
		matchedProcedures,
		knowledgeChunks,
		memoryContext,
		memoryPreloadCount,
		knowledgeUsage,
		stages,
		events,
	};
}

// ─── Helpers ──────────────────────────────────────────────────────────────

async function matchProceduresForTurn(args: {
	procedures: Procedure[];
	session: FlueSession;
	userMessage: string;
}): Promise<{ procedure: Procedure; metadata: { name: string }; body: string }[]> {
	const out: { procedure: Procedure; metadata: { name: string }; body: string }[] = [];
	for (const p of args.procedures) {
		try {
			const loaded = await loadProcedure(args.session, p);
			if (matchesProcedure({ ...p, _metadata: loaded.metadata }, args.userMessage)) {
				out.push({ procedure: p, metadata: loaded.metadata, body: loaded.body });
			}
		} catch (err) {
			console.error(
				`[floe] Failed to load procedure ${p.path}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}
	return out;
}

async function retrieveKnowledge(
	sources: KnowledgeSource[],
	session: FlueSession,
	query: string,
	emit: (e: AssistantOutputEvent) => void,
	respondingTo: string,
): Promise<KnowledgeChunk[]> {
	const all: KnowledgeChunk[] = [];
	for (const src of sources) {
		try {
			if (src.prepare) await src.prepare(session);
			emit({
				type: 'conversation_event',
				subtype: 'knowledge_query',
				data: { source: src.name, query },
				respondingTo,
			});
			const chunks = await src.search(query, { limit: 5 });
			if (chunks.length > 0) {
				all.push(...chunks);
				emit({
					type: 'conversation_event',
					subtype: 'knowledge_hit',
					data: { source: src.name, count: chunks.length, topScore: chunks[0]!.score },
					respondingTo,
				});
			}
		} catch (err) {
			console.error(
				`[floe] KnowledgeSource ${src.name} failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}
	all.sort((a, b) => b.score - a.score);
	return all.slice(0, 5);
}
