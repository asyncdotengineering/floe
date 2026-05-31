/**
 * Identity-required guard. Soft enforcement of "patient identity must be
 * verified before sensitive operations." If the inbound turn has no
 * `verifiedPatientId` in metadata, this validator REWRITES the user
 * message to prefix a system-prompt-style hint reminding the LLM to
 * start with identity verification before any tool call.
 *
 * This is a SOFT control — the LLM still receives the message + hint.
 * The HARD control lives in your real EHR/Rx MCP tools, which should
 * refuse to execute when no verifiedPatientId is in the request
 * context. This validator is a belt-and-braces nudge for the LLM.
 *
 * (The hard control we don't ship here because the MCP-side enforcement
 * lives in YOUR backend. The mock services intentionally don't enforce
 * patientId on operations — they're for orchestration testing, not
 * compliance.)
 */
import type { Validator } from '@floe/runtime';

export function identityRequiredGuard(): Validator {
	return {
		name: 'identity-required-guard',
		phase: 'preLLM',
		validate(turn, ctx) {
			const state = ctx.state as unknown as { userId?: string };
			if (state.userId) return { ok: true };
			// No verified patient id on file for this conversation. Prefix
			// the message so the LLM is reminded to verify before tools.
			const original = turn.userMessage ?? '';
			return {
				rewrite:
					'(INTERNAL CONTEXT: this conversation has not yet verified the patient identity. Before any patient-specific tool call, ask the patient for their MRN and DOB and call mcp__patient_fhir__verify_identity.)\n\n' +
					original,
			};
		},
	};
}
