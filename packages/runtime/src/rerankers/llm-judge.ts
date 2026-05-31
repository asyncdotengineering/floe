/**
 * LLM-as-judge reranker. Uses any Flue `session.prompt` (with a result
 * schema) to score candidates 0-10, then normalizes to [0, 1].
 *
 * Trade-offs:
 *   - Works with any LLM provider; no Cohere / Voyage API dep
 *   - Slow (1 LLM call per rerank batch) — use behind strong-signal bypass
 *   - Quality varies with model; pair with a small fast model (e.g.
 *     gemini-3.1-flash-lite, gpt-5.4-mini, claude-haiku-4-5)
 *
 * For production scale and quality, swap in `CohereReranker` or
 * `VoyageReranker` (HTTP, ~30 LOC user code).
 */
import * as v from 'valibot';
import type { FlueSession } from '@flue/runtime';
import type { Reranker, RerankCandidate, RerankResult } from './types.ts';

export interface LLMJudgeRerankerOptions {
	/** Flue session for the judge call. */
	session: FlueSession;
	/** Override model; default is whatever the session was initialized with. */
	model?: string;
	/** How many candidates per call. Larger batches = fewer calls, harder for the model. Default 10. */
	batchSize?: number;
	/** Name for telemetry. Default 'llm-judge'. */
	name?: string;
}

const ScoreSchema = v.object({
	scores: v.array(
		v.object({
			id: v.string(),
			score: v.pipe(v.number(), v.minValue(0), v.maxValue(10)),
		}),
	),
});

export class LLMJudgeReranker implements Reranker {
	readonly name: string;
	private readonly session: FlueSession;
	private readonly model: string | undefined;
	private readonly batchSize: number;

	constructor(opts: LLMJudgeRerankerOptions) {
		this.session = opts.session;
		this.model = opts.model;
		this.batchSize = opts.batchSize ?? 10;
		this.name = opts.name ?? 'llm-judge';
	}

	async rerank(args: {
		query: string;
		candidates: RerankCandidate[];
		limit?: number;
	}): Promise<RerankResult[]> {
		if (args.candidates.length === 0) return [];
		const all: RerankResult[] = [];
		for (let i = 0; i < args.candidates.length; i += this.batchSize) {
			const batch = args.candidates.slice(i, i + this.batchSize);
			const rubric = buildRubric(args.query, batch);
			const response = await this.session.prompt(rubric, {
				result: ScoreSchema,
				...(this.model ? { model: this.model } : {}),
			});
			const seen = new Set<string>();
			for (const s of response.data.scores) {
				if (seen.has(s.id)) continue;
				seen.add(s.id);
				all.push({ id: s.id, score: s.score / 10 });
			}
		}
		all.sort((a, b) => b.score - a.score);
		const limit = args.limit ?? all.length;
		return all.slice(0, limit);
	}
}

function buildRubric(query: string, candidates: RerankCandidate[]): string {
	const items = candidates
		.map((c, i) => `[${i + 1}] id="${c.id}"\n${c.text.slice(0, 800)}`)
		.join('\n\n---\n\n');
	return `Score each candidate's relevance to the query on a 0-10 integer scale. 10 = directly and completely answers the query. 5 = related but doesn't answer. 0 = irrelevant.

QUERY:
${query}

CANDIDATES:
${items}

Output JSON: { "scores": [{"id": "<id>", "score": <0-10>}, ...] }. Include every candidate exactly once.`;
}

export function llmJudgeReranker(opts: LLMJudgeRerankerOptions): LLMJudgeReranker {
	return new LLMJudgeReranker(opts);
}
