/**
 * Groundedness validator. Production-grade hallucination detection.
 *
 * Validates that the assistant didn't *invent* facts. Uses LLM-as-judge with
 * a hallucination-focused rubric (not a strict citation rubric — most CS bots
 * don't cite by number, that's not natural conversation):
 *
 *   1.0 — no hallucinations: every factual claim either matches a chunk OR
 *          is reasonable conversational glue (greetings, paraphrase, common knowledge)
 *   0.5 — minor drift: some specifics not in chunks but plausible
 *   0.0 — contains a clear fabrication that contradicts or invents facts
 *
 * Below `threshold` → retry with hint. Below `escalateBelow` → escalate.
 * No-op when there are no chunks (nothing to ground against).
 */
import * as v from 'valibot';
import { defineValidator } from '../define.ts';
import type { ValidationResult, Validator } from '../types.ts';

export interface GroundednessOptions {
	/** Avg score below this triggers retry/observe. Default 0.45. */
	threshold?: number;
	/** Avg score below this triggers escalate. Default 0.15. */
	escalateBelow?: number;
	/** Model used for the judge call. Defaults to the conversation's model. */
	judgeModel?: string;
	/**
	 * Phase. Default is `'postLLM-async'` — groundedness runs as a side channel
	 * after the response is sent, logging issues without blocking the user.
	 * This is the right v1 production default: groundedness judges have false
	 * positives on conversational phrasing (model paraphrases chunks naturally),
	 * and blocking the response on every false positive degrades UX.
	 *
	 * Set to `'postLLM'` if you want blocking groundedness (for compliance use
	 * cases where any hallucination must be caught before send). Recommend
	 * tuning the threshold lower in that mode.
	 */
	phase?: 'postLLM' | 'postLLM-async';
}

export function groundedness(opts: GroundednessOptions = {}): Validator {
	const threshold = opts.threshold ?? 0.45;
	const escalateBelow = opts.escalateBelow ?? 0.15;

	return defineValidator({
		name: 'groundedness',
		phase: opts.phase ?? 'postLLM-async',
		async validate(turn, ctx): Promise<ValidationResult> {
			const chunks = turn.knowledgeChunks ?? [];
			if (chunks.length === 0 || !turn.assistantText) {
				return { ok: true };
			}

			const rubric = `You are a hallucination detector for a customer-service AI. Score the ASSISTANT_RESPONSE for groundedness against the REFERENCE_CHUNKS.

Rubric (think about specific factual claims — prices, policies, numbers, dates, feature lists):
- 1.0 = no hallucinations. Every factual claim is supported by a chunk OR is reasonable conversational glue (greetings, paraphrase, restating the user's question). Citations are NOT required — natural phrasing of facts from chunks counts as supported.
- 0.7 = nearly clean. Tiny paraphrase drift or one minor unsupported specific.
- 0.5 = some claims are unsupported. Could be hallucination, could be common knowledge — uncertain.
- 0.2 = at least one clear unsupported specific (e.g., a price or policy detail not in the chunks).
- 0.0 = the response contradicts a chunk, or invents a major specific.

REFERENCE_CHUNKS:
${chunks.map((c, i) => `[${i + 1}] (${c.source})\n${c.text}`).join('\n\n---\n\n')}

ASSISTANT_RESPONSE:
${turn.assistantText}`;

			const schema = v.object({
				score: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
				reason: v.string(),
			});

			try {
				const response = await ctx.session.prompt(rubric, {
					result: schema,
					...(opts.judgeModel ? { model: opts.judgeModel } : {}),
				});
				const { score, reason } = response.data;

				if (score < escalateBelow) {
					return {
						escalate: {
							reason: `Groundedness check failed (score ${score.toFixed(2)} < ${escalateBelow}). Judge said: ${reason}`,
						},
					};
				}
				if (score < threshold) {
					return {
						retry: {
							hint: `Your previous response had unsupported claims (groundedness score ${score.toFixed(2)}). Stick to facts from the reference chunks. Judge said: ${reason}`,
						},
					};
				}
				return { ok: true };
			} catch (err) {
				console.error(
					`[floe:groundedness] judge call failed: ${err instanceof Error ? err.message : String(err)}`,
				);
				return { ok: true };
			}
		},
	});
}
