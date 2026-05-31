/**
 * Hybrid knowledge source: BM25 + vector similarity + optional reranker
 * + strong-signal short-circuit, all fused with Reciprocal Rank Fusion.
 *
 * Pre-LLM pattern: this is called by the orchestrator BEFORE the main
 * LLM call (just like `workspaceBm25`), so it costs at most one embed
 * call + optional rerank call per turn. This is the architecture our
 * earlier bench proved beats AriaFlow's tool-call RAG by 1-2s TTFT.
 *
 * Patterns borrowed from qmd (`store.ts:4496-4777`):
 *   - Strong-signal short-circuit: if BM25 top-1 ≥ minScore AND gap to
 *     #2 ≥ minGap, skip embed+rerank entirely. Saves TTFT on the ~60%
 *     of queries where BM25 is obviously correct.
 *   - Reciprocal Rank Fusion (k=60) over BM25 + vector ranks.
 *   - Per-chunk reranking (the reranker sees chunks, not whole docs).
 *
 * Cloudflare-safe: works with any `Embedder` (OpenAI/WorkersAI) and any
 * `VectorStore` (in-memory/D1/Vectorize/Pgvector). No native deps.
 */
import type { FlueSession } from '@flue/runtime';
import { defineKnowledgeSource } from '../define.ts';
import type { KnowledgeChunk, KnowledgeSource } from '../types.ts';
import type { Embedder } from '../embedders/types.ts';
import type { Reranker } from '../rerankers/types.ts';
import type { VectorStore } from '../vectorstores/types.ts';
import { chunkMarkdownWithPositions } from '../chunkers/markdown.ts';
import { collectFiles } from './walk.ts';

const RRF_K = 60;
const BM25_K1 = 1.5;
const BM25_B = 0.75;

const STOPWORDS = new Set([
	'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
	'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
	'should', 'may', 'might', 'can', 'and', 'or', 'but', 'not', 'no',
	'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as',
	'this', 'that', 'these', 'those', 'it', 'its', 'i', 'you', 'he', 'she',
	'we', 'they', 'them', 'their', 'his', 'her', 'me', 'us', 'my', 'your',
	'our', 'so', 'if', 'than', 'then', 'because', 'while', 'about', 'into',
]);

export interface HybridKnowledgeOptions {
	/** Source name returned in chunks. Default 'hybrid'. */
	name?: string;
	/** Markdown files to index. Same glob support as `workspaceBm25`. */
	paths: string[];
	/** Required: text embedder. */
	embedder: Embedder;
	/** Required: vector store backend. Its `.dimensions` MUST match `embedder.dimensions`. */
	vectorStore: VectorStore;
	/** Optional: reranker applied to the top candidates after RRF. */
	reranker?: Reranker;
	/**
	 * Strong-signal bypass. When BM25 top-1 score ≥ `minScore` AND the gap
	 * to the second-best ≥ `minGap`, skip the embed + vector + rerank
	 * pipeline. Saves ~1s+ TTFT on confident queries.
	 *
	 * qmd defaults: `{ minScore: 0.85, minGap: 0.15 }`. Pass `false` to
	 * disable. Default: enabled with qmd defaults.
	 */
	strongSignal?: { minScore: number; minGap: number } | false;
	/** Per-chunk character budget. Default 1200. */
	chunkSize?: number;
	/** Min chunk size. Default 80. */
	minChunkSize?: number;
	/**
	 * BM25 candidates passed to the vector + RRF stage. Default 20. The
	 * vector search also fetches `bm25CandidateLimit` candidates.
	 */
	bm25CandidateLimit?: number;
	/** Rerank input cap (top N after RRF). qmd default 40. */
	rerankCandidateLimit?: number;
}

interface IndexedChunk {
	id: string;
	source: string;
	text: string;
	tokens: string[];
	termFreq: Map<string, number>;
	length: number;
}

interface IndexState {
	chunks: IndexedChunk[];
	totalDocs: number;
	avgDocLength: number;
	df: Map<string, number>;
}

export function hybridKnowledge(opts: HybridKnowledgeOptions): KnowledgeSource {
	const sourceName = opts.name ?? 'hybrid';
	const chunkSize = opts.chunkSize ?? 1200;
	const minChunkSize = opts.minChunkSize ?? 80;
	const strongSignal =
		opts.strongSignal === false
			? null
			: opts.strongSignal ?? { minScore: 0.85, minGap: 0.15 };
	const bm25Cap = opts.bm25CandidateLimit ?? 20;
	const rerankCap = opts.rerankCandidateLimit ?? 40;

	if (opts.embedder.dimensions !== opts.vectorStore.dimensions) {
		throw new Error(
			`[hybridKnowledge] embedder.dimensions (${opts.embedder.dimensions}) ≠ vectorStore.dimensions (${opts.vectorStore.dimensions}). Pick matching settings or specify dimensions explicitly.`,
		);
	}

	let index: IndexState | null = null;
	let prepared = false;

	return defineKnowledgeSource({
		name: sourceName,

		async prepare(session: FlueSession): Promise<void> {
			if (prepared) return;
			prepared = true;

			const files = await collectFiles(session, opts.paths);
			const chunks: IndexedChunk[] = [];
			const toEmbed: Array<{ id: string; text: string }> = [];
			for (const filePath of files) {
				try {
					const content = await session.fs.readFile(filePath);
					const fileChunks = chunkMarkdownWithPositions(content, {
						targetChars: chunkSize,
						minChars: minChunkSize,
					});
					for (let i = 0; i < fileChunks.length; i++) {
						const id = `${filePath}#${i}`;
						const text = fileChunks[i]!.text;
						const tokens = tokenize(text);
						const termFreq = new Map<string, number>();
						for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
						chunks.push({
							id,
							source: filePath,
							text,
							tokens,
							termFreq,
							length: tokens.length,
						});
						toEmbed.push({ id, text });
					}
				} catch (err) {
					console.error(
						`[hybridKnowledge] failed to read ${filePath}: ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
				}
			}

			const totalDocs = chunks.length;
			const avgDocLength =
				totalDocs === 0 ? 0 : chunks.reduce((acc, d) => acc + d.length, 0) / totalDocs;
			const df = new Map<string, number>();
			for (const d of chunks) {
				for (const term of new Set(d.tokens)) {
					df.set(term, (df.get(term) ?? 0) + 1);
				}
			}
			index = { chunks, totalDocs, avgDocLength, df };

			// Embed + upsert. Skipped silently when there's nothing to index.
			if (toEmbed.length > 0) {
				const embeddings = await opts.embedder.embed(toEmbed.map((t) => t.text));
				await opts.vectorStore.upsert(
					toEmbed.map((t, i) => ({
						id: t.id,
						embedding: embeddings[i]!,
						text: t.text,
						metadata: { source: t.id.split('#')[0]! },
					})),
				);
			}
		},

		async search(query, queryOpts): Promise<KnowledgeChunk[]> {
			if (!index || index.totalDocs === 0) return [];
			const limit = queryOpts?.limit ?? 5;
			const threshold = queryOpts?.threshold ?? 0;

			// 1. BM25 first.
			const bm25 = bm25Search(index, query, bm25Cap);
			if (bm25.length === 0 && strongSignal === null) {
				// Fall through to vector-only.
			}

			// 1b. Strong-signal short-circuit: if BM25 top-1 is high AND the
			// gap to runner-up is large, return BM25 results and skip vector +
			// rerank.
			if (strongSignal !== null && bm25.length >= 1) {
				const top = bm25[0]!;
				const second = bm25[1]?.score ?? 0;
				if (top.score >= strongSignal.minScore && top.score - second >= strongSignal.minGap) {
					return finalize(bm25.slice(0, limit), threshold);
				}
			}

			// 2. Vector search.
			let vector: Array<{ id: string; score: number; text: string; source: string }> = [];
			try {
				const [embedding] = await opts.embedder.embed([query]);
				if (embedding) {
					const matches = await opts.vectorStore.query({
						embedding,
						limit: bm25Cap,
					});
					vector = matches.map((m) => ({
						id: m.id,
						score: m.score,
						text: m.text,
						source: (m.metadata?.source as string | undefined) ?? m.id.split('#')[0]!,
					}));
				}
			} catch (err) {
				console.error(
					`[hybridKnowledge] vector search failed (falling back to BM25 only): ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}

			// 3. RRF fusion.
			const fused = reciprocalRankFusion([bm25, vector]);
			if (fused.length === 0) return [];

			// 4. Optional reranker on top-N candidates.
			let final = fused.slice(0, Math.min(rerankCap, fused.length));
			if (opts.reranker) {
				try {
					const reranked = await opts.reranker.rerank({
						query,
						candidates: final.map((f) => ({ id: f.id, text: f.text })),
						limit: limit,
					});
					const byId = new Map(final.map((f) => [f.id, f]));
					final = reranked
						.map((r) => {
							const f = byId.get(r.id);
							return f ? { ...f, score: r.score } : null;
						})
						.filter((x): x is (typeof final)[number] => x !== null);
				} catch (err) {
					console.error(
						`[hybridKnowledge] reranker failed (using RRF order): ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
				}
			}

			return finalize(final.slice(0, limit), threshold);
		},
	});

	// ─── Inner helpers ──────────────────────────────────────────────────

	function finalize(
		items: Array<{ id: string; score: number; text: string; source: string }>,
		threshold: number,
	): KnowledgeChunk[] {
		if (items.length === 0) return [];
		const topScore = items[0]!.score;
		const out: KnowledgeChunk[] = [];
		for (const it of items) {
			const normalized = topScore === 0 ? 0 : it.score / topScore;
			if (normalized < threshold) break;
			out.push({
				id: it.id,
				text: it.text,
				source: it.source,
				score: normalized,
				metadata: { rawScore: it.score },
			});
		}
		return out;
	}
}

// ─── BM25 (kept inline so this module has no inter-module coupling) ─────

interface ScoredCandidate {
	id: string;
	score: number;
	text: string;
	source: string;
}

function bm25Search(idx: IndexState, query: string, limit: number): ScoredCandidate[] {
	const qTokens = Array.from(new Set(tokenize(query)));
	if (qTokens.length === 0) return [];
	const scored: ScoredCandidate[] = [];
	for (const d of idx.chunks) {
		let s = 0;
		for (const term of qTokens) {
			const tf = d.termFreq.get(term);
			if (!tf) continue;
			const docFreq = idx.df.get(term) ?? 0;
			const idf = Math.log((idx.totalDocs - docFreq + 0.5) / (docFreq + 0.5) + 1);
			const norm = 1 - BM25_B + BM25_B * (d.length / (idx.avgDocLength || 1));
			s += idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm));
		}
		if (s > 0) {
			scored.push({ id: d.id, score: s, text: d.text, source: d.source });
		}
	}
	scored.sort((a, b) => b.score - a.score);
	const top = scored.slice(0, limit);
	if (top.length === 0) return [];
	// Normalize against top so it composes with cosine in [0, 1].
	const max = top[0]!.score;
	return top.map((c) => ({ ...c, score: max === 0 ? 0 : c.score / max }));
}

function reciprocalRankFusion(
	rankings: ScoredCandidate[][],
): ScoredCandidate[] {
	const fused = new Map<string, { item: ScoredCandidate; score: number }>();
	for (const ranking of rankings) {
		for (let rank = 0; rank < ranking.length; rank++) {
			const item = ranking[rank]!;
			const contribution = 1 / (RRF_K + rank + 1);
			const existing = fused.get(item.id);
			if (existing) {
				existing.score += contribution;
			} else {
				fused.set(item.id, { item, score: contribution });
			}
		}
	}
	return Array.from(fused.values())
		.sort((a, b) => b.score - a.score)
		.map(({ item, score }) => ({ ...item, score }));
}

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^\w\s]/g, ' ')
		.split(/\s+/)
		.filter((t) => t.length > 1 && !STOPWORDS.has(t))
		.map(stem);
}

function stem(t: string): string {
	if (t.endsWith('ing') && t.length > 5) return t.slice(0, -3);
	if (t.endsWith('ed') && t.length > 4) return t.slice(0, -2);
	if (t.endsWith('s') && !t.endsWith('ss') && t.length > 3) return t.slice(0, -1);
	return t;
}
