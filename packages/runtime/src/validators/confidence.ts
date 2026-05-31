/**
 * Confidence validator.
 *
 * Two modes:
 *  1. Structured: if the active Node has a `result` schema with a `confidence`
 *     field, this validator reads it directly (no LLM call) and triggers
 *     `disambiguate` below threshold.
 *  2. Inferred: when no structured confidence is available, a small LLM-as-judge
 *     scores how confident the response is. Useful for chat where you want to
 *     ask a follow-up before committing to a wrong action.
 */
import * as v from 'valibot';
import { defineValidator } from '../define.ts';
import type { ValidationResult, Validator } from '../types.ts';

export interface ConfidenceOptions {
	/** Below this score, trigger disambiguation. Default 0.6. */
	threshold?: number;
	/** Disambiguation text the user sees. Default is a generic clarification ask. */
	disambiguateText?: string;
	/** Model used for the inferred-confidence judge. */
	judgeModel?: string;
	/** Force inferred mode even when structured confidence is available. Default false. */
	forceInferred?: boolean;
}

export function confidence(opts: ConfidenceOptions = {}): Validator {
	const threshold = opts.threshold ?? 0.6;
	const text =
		opts.disambiguateText ??
		"I want to make sure I help you with the right thing — could you tell me a bit more?";

	return defineValidator({
		name: 'confidence',
		phase: 'postLLM',
		async validate(turn, ctx): Promise<ValidationResult> {
			if (!turn.assistantText) return { ok: true };

			// 1. Structured path: not currently accessible because the orchestrator
			//    doesn't expose the structured `data` to validators in v1. Future
			//    improvement: thread `responseData` through TurnUnderReview.
			//    For v1, fall through to inferred.

			// 2. Inferred path: LLM-as-judge.
			if (opts.forceInferred || true) {
				const schema = v.object({
					confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
					reason: v.string(),
				});
				const prompt = `Score how confident this assistant response sounds (0..1). Hedge words ("I think", "maybe"), low-information answers, and unclear answers score low. Direct, specific, well-grounded answers score high.

USER: ${turn.userMessage}

ASSISTANT: ${turn.assistantText}`;
				try {
					const response = await ctx.session.prompt(prompt, {
						result: schema,
						...(opts.judgeModel ? { model: opts.judgeModel } : {}),
					});
					if (response.data.confidence < threshold) {
						return { disambiguate: text };
					}
					return { ok: true };
				} catch (err) {
					console.error(
						`[floe:confidence] judge call failed: ${err instanceof Error ? err.message : String(err)}`,
					);
					return { ok: true };
				}
			}
		},
	});
}
