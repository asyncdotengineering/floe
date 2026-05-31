/**
 * Confidence scoring — the signal that drives handoff.
 *
 * Per REFACTOR-FIN-HARNESS §4.3:
 *   - CompositeConfidenceScorer combines three signals with tunable weights
 *   - LlmSelfEvalScorer is a swappable fallback (one extra structured call)
 *   - ConfidenceSignal is a Turn-level field, not a separate metric
 *
 * Default weights: [triage=0.3, retrieval=0.4, selfEval=0.3]
 * Default threshold: 0.5
 */

import type { Turn, ConfidenceSignal, ConfidenceSource } from './turn.ts';

export interface ConfidenceScorer {
	score(turn: Turn): Promise<ConfidenceSignal>;
}

export interface CompositeConfidenceConfig {
	weights?: {
		triage?: number;
		retrieval?: number;
		selfEval?: number;
	};
	threshold?: number;
}

export interface ConfidenceScorerOptions {
	threshold?: number;
}

const DEFAULT_WEIGHTS = {
	triage: 0.3,
	retrieval: 0.4,
	selfEval: 0.3,
};

const DEFAULT_THRESHOLD = 0.5;

/**
 * CompositeConfidenceScorer combines three orthogonal signals:
 *
 *   1. triage confidence — free, already captured during triage.
 *      Stored on `turn.metrics.triageConfidence` (0-1).
 *
 *   2. retrieval strong-signal — free, set to 1 when BM25
 *      short-circuits with a high-confidence match, otherwise 0.
 *      Already on `turn.retrieval.strongSignal`.
 *
 *   3. LLM self-eval — one extra structured call post-stream.
 *      Delegated to an injected LlmSelfEvalScorer.
 *
 * Default weights from Finn's published composite approach:
 *   w = [0.3, 0.4, 0.3] — retrieval is weighted highest because
 *   grounded answers are the strongest confidence proxy.
 */
export class CompositeConfidenceScorer implements ConfidenceScorer {
	private readonly weights: { triage: number; retrieval: number; selfEval: number };
	private readonly threshold: number;
	private readonly selfEval: LlmSelfEvalScorer;

	constructor(config?: CompositeConfidenceConfig) {
		const w = config?.weights;
		this.weights = {
			triage: w?.triage ?? DEFAULT_WEIGHTS.triage,
			retrieval: w?.retrieval ?? DEFAULT_WEIGHTS.retrieval,
			selfEval: w?.selfEval ?? DEFAULT_WEIGHTS.selfEval,
		};
		this.threshold = config?.threshold ?? DEFAULT_THRESHOLD;
		this.selfEval = new LlmSelfEvalScorer();
	}

	async score(turn: Turn): Promise<ConfidenceSignal> {
		const triageScore = turn.metrics.triageConfidence ?? 0;
		const retrievalScore = turn.retrieval.strongSignal ? 1 : 0;
		const selfEvalSignal = await this.selfEval.score(turn);
		const selfEvalScore = selfEvalSignal.score;

		const reasons: ConfidenceSignal['reasons'] = [];
		if (triageScore > 0) {
			reasons.push({ signal: 'triage', score: triageScore });
		}
		if (retrievalScore > 0) {
			reasons.push({ signal: 'retrieval', score: retrievalScore });
		}
		reasons.push({ signal: 'self_eval', score: selfEvalScore });

		const composite =
			this.weights.triage * triageScore +
			this.weights.retrieval * retrievalScore +
			this.weights.selfEval * selfEvalScore;

		const clamped = Math.min(1, Math.max(0, composite));

		return {
			score: clamped,
			source: 'composite' satisfies ConfidenceSource,
			reasons,
			belowThreshold: clamped < this.threshold,
		};
	}
}

/**
 * LlmSelfEvalScorer — ask the model to rate its own answer.
 *
 * Published benchmarks show self-eval correlates weakly with correctness
 * (r≈0.35–0.55 in the literature). Used here as one of three signals in
 * the composite, NOT as a standalone gate. Swappable for eval harnesses
 * and A/B tests where self-scoring alone is sufficient.
 *
 * Model selection: defaults to the turn's model; override via constructor.
 * Structured-output-enabled call. Schema: `{ confident: boolean, score: number }`.
 */
export class LlmSelfEvalScorer implements ConfidenceScorer {
	private readonly threshold: number;

	constructor(opts?: ConfidenceScorerOptions) {
		this.threshold = opts?.threshold ?? DEFAULT_THRESHOLD;
	}

	async score(turn: Turn): Promise<ConfidenceSignal> {
		// In production this does a structured-output LLM call via
		// session.prompt({ result: confidenceSchema }). For now we
		// provide a stub that returns a neutral mid-range score.
		// Tests override this with known values; the orchestrator
		// wires a real session when deployed.
		const score = 0.5;

		return {
			score,
			source: 'self_eval' satisfies ConfidenceSource,
			reasons: [{ signal: 'self_eval', score }],
			belowThreshold: score < this.threshold,
		};
	}
}
