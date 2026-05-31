import { describe, expect, it } from 'vitest';
import {
	CompositeConfidenceScorer,
	LlmSelfEvalScorer,
	type ConfidenceScorer,
} from '../src/confidence.ts';
import { makeTurn, type Turn } from '../src/turn.ts';
import type { Identity } from '../src/identity.ts';

const identity: Identity = { tenantId: 't-1', userId: 'alice' };

function freshTurn(overrides?: Partial<Turn>): Turn {
	const turn = makeTurn({
		conversationId: 'c-1',
		tenantId: 't-1',
		identity,
		input: { type: 'text', text: 'hi', receivedAt: 0 },
	});
	if (overrides) Object.assign(turn, overrides);
	return turn;
}

describe('CompositeConfidenceScorer', () => {
	it('computes composite from triage + retrieval + selfEval with default weights', async () => {
		const scorer = new CompositeConfidenceScorer();
		const turn = freshTurn();
		turn.metrics.triageConfidence = 0.8;
		turn.retrieval.strongSignal = true; // retrievalScore = 1
		// LlmSelfEvalScorer produces 0.5 by default

		const signal = await scorer.score(turn);

		// expected: 0.3*0.8 + 0.4*1 + 0.3*0.5 = 0.24 + 0.4 + 0.15 = 0.79
		expect(signal.score).toBeCloseTo(0.79);
		expect(signal.source).toBe('composite');
		expect(signal.belowThreshold).toBe(false);
		expect(signal.reasons).toHaveLength(3);
	});

	it('flags below threshold when composite is low', async () => {
		const scorer = new CompositeConfidenceScorer({ threshold: 0.3 });
		const turn = freshTurn();
		turn.metrics.triageConfidence = 0.1;
		turn.retrieval.strongSignal = false;
		// selfEval = 0.5

		const signal = await scorer.score(turn);

		// 0.3*0.1 + 0.4*0 + 0.3*0.5 = 0.03 + 0 + 0.15 = 0.18
		expect(signal.score).toBeCloseTo(0.18);
		expect(signal.belowThreshold).toBe(true);
	});

	it('clamps score to [0, 1] range', async () => {
		const scorer = new CompositeConfidenceScorer();
		const turn = freshTurn();
		turn.metrics.triageConfidence = 2.0; // unrealistic, but guards against overflow
		turn.retrieval.strongSignal = true;
		// selfEval = 0.5

		const signal = await scorer.score(turn);
		expect(signal.score).toBeLessThanOrEqual(1);
		expect(signal.score).toBeGreaterThanOrEqual(0);
	});

	it('accepts custom per-signal weights', async () => {
		const scorer = new CompositeConfidenceScorer({
			weights: { triage: 0.5, retrieval: 0.3, selfEval: 0.2 },
		});
		const turn = freshTurn();
		turn.metrics.triageConfidence = 0.9;
		turn.retrieval.strongSignal = false;
		// selfEval = 0.5

		const signal = await scorer.score(turn);

		// 0.5*0.9 + 0.3*0 + 0.2*0.5 = 0.45 + 0 + 0.1 = 0.55
		expect(signal.score).toBeCloseTo(0.55);
	});

	it('defaults triageConfidence to 0 when not set', async () => {
		const scorer = new CompositeConfidenceScorer();
		const turn = freshTurn();
		// don't set triageConfidence
		turn.retrieval.strongSignal = true;
		// selfEval = 0.5

		const signal = await scorer.score(turn);
		// 0.3*0 + 0.4*1 + 0.3*0.5 = 0.55
		expect(signal.score).toBeCloseTo(0.55);
		expect(signal.reasons.map((r) => r.signal)).not.toContain('triage');
	});

	it('does not include retrieval reason when strongSignal is false', async () => {
		const scorer = new CompositeConfidenceScorer();
		const turn = freshTurn();
		turn.metrics.triageConfidence = 0.5;
		turn.retrieval.strongSignal = false;

		const signal = await scorer.score(turn);
		const retrievalReason = signal.reasons.find((r) => r.signal === 'retrieval');
		expect(retrievalReason).toBeUndefined();
	});
});

describe('LlmSelfEvalScorer', () => {
	it('produces a result with self_eval source', async () => {
		const scorer = new LlmSelfEvalScorer();
		const turn = freshTurn();

		const signal = await scorer.score(turn);
		expect(signal.source).toBe('self_eval');
		expect(signal.score).toBeGreaterThanOrEqual(0);
		expect(signal.score).toBeLessThanOrEqual(1);
		expect(signal.reasons).toHaveLength(1);
		expect(signal.reasons[0]!.signal).toBe('self_eval');
	});

	it('respects threshold override', async () => {
		const scorer = new LlmSelfEvalScorer({ threshold: 0.8 });
		const turn = freshTurn();

		const signal = await scorer.score(turn);
		// stub returns 0.5, threshold is 0.8
		expect(signal.belowThreshold).toBe(true);
	});

	it('scorers do not share state across calls', async () => {
		const scorer = new LlmSelfEvalScorer();
		const turn = freshTurn();

		const s1 = await scorer.score(turn);
		const s2 = await scorer.score(turn);
		// Each call should be independent
		expect(s1.score).toBe(s2.score);
	});
});
