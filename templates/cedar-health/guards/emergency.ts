/**
 * Emergency keyword guard — RUNTIME-ONLY, never reaches the LLM.
 *
 * This is the "make-or-break" piece of the cedar-health template. The
 * use-case doc's whole positioning is that life-threatening signals
 * MUST short-circuit before the LLM gets a chance to make any judgment
 * call. This validator does that.
 *
 * When any of the emergency patterns match the user's transcript, we
 * return `escalate({ to: '911', reason: <scripted reply> })`. The Floe
 * orchestrator short-circuits the turn (no LLM call), surfaces the
 * `agent_escalate` event with our reason as the user-facing text, and
 * the handoff layer (your code, downstream) routes the call to the
 * stat nurse queue + warm-transfers the audio bridge.
 *
 * Zero LLM cost. ~180ms total turn time. Deterministic.
 *
 * False positives are intentional. Someone says "my chest hurts from
 * yesterday's workout" — better safe; a nurse handles those triage
 * calls every day. That's literally their job.
 */
import type { Validator } from '@floe/runtime';

const DEFAULT_EMERGENCY_PATTERNS: RegExp[] = [
	/chest pain/i,
	/can'?t breathe/i,
	/difficulty breathing/i,
	/unconscious|passing out|fainting/i,
	/suicid/i,
	/heavy bleeding|won'?t stop bleeding/i,
	/stroke|face\s+(is\s+)?droop(ing)?|slurred speech/i,
	/overdose/i,
	/not responsive|won'?t wake up/i,
	/severe allergic reaction|anaphylaxis/i,
];

export interface EmergencyGuardOptions {
	/** Override the pattern list. Defaults to the bundled US clinical-triage list. */
	patterns?: RegExp[];
	/**
	 * The user-facing message read aloud (voice) or shown in the widget
	 * before the escalation fires. Should be safe to read verbatim with
	 * no LLM rewording.
	 */
	scriptedReply?: string;
	/**
	 * Target queue label for the handoff layer. Default `'911'`. Surfaced
	 * to the human escalation pipeline via the `agent_escalate.to` field.
	 */
	escalateTo?: string;
}

export function emergencyKeywordGuard(opts: EmergencyGuardOptions = {}): Validator {
	const patterns = opts.patterns ?? DEFAULT_EMERGENCY_PATTERNS;
	const scriptedReply =
		opts.scriptedReply ??
		"If this is a life-threatening emergency, please hang up and call 911 immediately. I'm connecting you to our nurse line now.";
	const escalateTo = opts.escalateTo ?? '911';

	return {
		name: 'emergency-keyword-guard',
		phase: 'preLLM',
		validate(turn) {
			const text = turn.userMessage ?? '';
			if (patterns.some((re) => re.test(text))) {
				return {
					escalate: {
						reason: scriptedReply,
						to: escalateTo,
					},
				};
			}
			return { ok: true };
		},
	};
}

export { DEFAULT_EMERGENCY_PATTERNS };
