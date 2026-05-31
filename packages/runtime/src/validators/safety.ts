/**
 * Safety validator. Production-grade.
 *
 * Classifies the assistant response against a configurable policy. The
 * default policy bars:
 *
 *  - explicit personal data disclosure (SSN, credit-card, full bank account)
 *  - encouragement of self-harm or violence
 *  - medical/legal/financial advice not flagged as "not professional advice"
 *  - confidential-information leakage (the model claiming things only the
 *    company would know)
 *
 * Configurable via `policy` (a markdown-ish rubric the judge LLM reads).
 *
 * Verdict: `ok` if the response passes; `rewrite` with a sanitized response if
 * the judge produced one; `escalate` if the violation is severe.
 */
import * as v from 'valibot';
import { defineValidator } from '../define.ts';
import type { ValidationResult, Validator } from '../types.ts';

const DEFAULT_POLICY = `Reject responses that:
- include personal data (SSN, credit card numbers, full bank account numbers, addresses)
- encourage self-harm, violence, or illegal activity
- give specific medical, legal, or financial advice without a "not professional advice" disclaimer
- claim or imply confidential or non-public information
- contain hate speech, slurs, or harassment
- ask the user for credentials, passwords, or one-time codes`;

export interface SafetyOptions {
	/** Custom policy text. Defaults to a reasonable starter set. */
	policy?: string;
	/** Model used for the judge call. */
	judgeModel?: string;
	/**
	 * Phase. **Default `'postLLM-async'`** — the validator runs as a side
	 * channel *after* the response stream closes, so the user-facing
	 * latency is unaffected. Verdicts land on the observability sink.
	 *
	 * Set `'postLLM'` only if you need the synchronous-rewrite-or-escalate
	 * behavior (the safety rewrite replaces the assistant text before it
	 * reaches the user). That mode adds ~1–2 s to TTFT of the LAST byte —
	 * acceptable for low-stakes chat, voice-fatal. See `docs/LATENCY.md`.
	 */
	phase?: 'preLLM' | 'postLLM' | 'postLLM-async';
}

export function safety(opts: SafetyOptions = {}): Validator {
	const policy = opts.policy ?? DEFAULT_POLICY;

	return defineValidator({
		name: 'safety',
		phase: opts.phase ?? 'postLLM-async',
		async validate(turn, ctx): Promise<ValidationResult> {
			const target = turn.assistantText ?? turn.userMessage;
			if (!target) return { ok: true };

			const schema = v.object({
				verdict: v.picklist(['pass', 'rewrite', 'escalate']),
				rewrittenText: v.optional(v.string()),
				reason: v.string(),
				severity: v.picklist(['low', 'medium', 'high']),
			});

			const prompt = `You are a strict safety classifier for a customer-facing AI agent.

Policy:
${policy}

Text under review:
"""
${target}
"""

If the text violates policy, return verdict "rewrite" with a sanitized version, or "escalate" for severe violations. Otherwise return "pass".`;

			try {
				const response = await ctx.session.prompt(prompt, {
					result: schema,
					...(opts.judgeModel ? { model: opts.judgeModel } : {}),
				});
				const { verdict, rewrittenText, reason, severity } = response.data;

				if (verdict === 'pass') return { ok: true };
				if (verdict === 'escalate' || severity === 'high') {
					return {
						escalate: {
							reason: `Safety violation (${severity}): ${reason}`,
						},
					};
				}
				if (verdict === 'rewrite' && rewrittenText) {
					return { rewrite: rewrittenText };
				}
				// Defensive: if rewrite chosen without text, escalate.
				return { escalate: { reason: `Safety policy concern: ${reason}` } };
			} catch (err) {
				console.error(
					`[floe:safety] judge call failed: ${err instanceof Error ? err.message : String(err)}`,
				);
				return { ok: true };
			}
		},
	});
}
