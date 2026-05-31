/**
 * Cedar Health Assistant config — multi-specialty clinic patient assistant.
 *
 * The make-or-break template: demonstrates that the runtime catches
 * life-threatening signals BEFORE the LLM gets a chance to make any
 * judgment call. The `emergencyKeywordGuard` validator runs at the
 * preLLM phase and short-circuits the turn with a scripted 911 reply
 * + escalation — zero LLM cost, ~180ms turn time, deterministic.
 *
 * Channels: web (patient portal) + voice (phone line). MCP: Patient
 * FHIR (lite) + Rx + Billing, all mocked via @floe/mock-services.
 *
 * Scoping caveat: this is NOT a deployable medical bot. Real medical
 * AI requires medical advisory board oversight, BAA-covered
 * infrastructure (LLM provider + hosting + observability), FDA
 * navigation, malpractice considerations. Floe shows the SHAPE; the
 * regulatory scaffolding is on you.
 */
import { Assistant } from '@floe/runtime';
import { localSandbox } from '@floe/runtime/sandbox/local';
import { workspaceBm25 } from '@floe/runtime/knowledge/workspace-bm25';
import { safety, piiRedaction } from '@floe/runtime/validators';
import { InMemoryMemoryService } from '@floe/runtime/memory';
import { mountAllMocks, type MountedMocks } from './mocks.ts';
import { emergencyKeywordGuard } from './guards/emergency.ts';
import { identityRequiredGuard } from './guards/identity-required.ts';

export async function createCedarHealth(): Promise<{
	assistant: Assistant;
	mocks: MountedMocks;
}> {
	const mocks = await mountAllMocks();

	const assistant = new Assistant({
		name: 'cedar-health',
		mode: 'coordinate',
		model: process.env.FLOE_MODEL ?? 'openai/gpt-4.1-mini',
		sandbox: localSandbox(),
		configDir: import.meta.dirname,

		systemPrompt: `You are Cedar Health's patient assistant. You help with
APPOINTMENTS, prescription REFILLS (routine, pre-approved only),
BILLING questions, and routing NON-EMERGENCY symptom questions to the
right care level.

YOU DO NOT DIAGNOSE, INTERPRET TEST RESULTS, OR GIVE MEDICAL ADVICE.

For any symptom question, delegate to the 'triage-router' role.
For appointments, delegate to 'scheduler'.
For billing, delegate to 'billing'.

ALWAYS verify the patient's identity (call mcp__patient_fhir__verify_identity
with MRN + DOB) BEFORE any patient-specific tool call. If the conversation
already has a verified patient id, you can skip the verification step.

Available MCP tools:
- mcp__patient_fhir__*  (verify_identity, get_patient, list_appointments,
  schedule_appointment, reschedule_appointment, cancel_appointment)
- mcp__rx__* (list_for_patient, request_refill, request_renewal)
- mcp__billing__* (list_invoices_for_patient, get_invoice, verify_insurance,
  file_dispute)

NEVER quote insurance coverage from memory — always call verify_insurance.
NEVER promise a refill for a 'needs_renewal' prescription — file a renewal
request instead.`,

		roles: {
			scheduler: {
				name: 'scheduler',
				description:
					'Appointment booking, reschedule, cancel. Always confirm provider + location + date + time before booking.',
				instructions: `You handle appointment scheduling.

OPERATING RULES:
- BEFORE any tool call: confirm the patient's identity is verified (the
  host should have already done verify_identity).
- BEFORE booking: confirm provider, location, date, time with the patient
  in one sentence.
- For new patients without an established provider, escalate to a human
  scheduler — don't auto-route.
- For provider changes (the doctor is on leave), escalate.
- DO NOT use task() — you ARE the specialist.`,
			},
			'triage-router': {
				name: 'triage-router',
				description:
					'Non-emergency symptom routing. Matches a described symptom to one of SELF_CARE / SCHEDULE_VISIT / NURSE_LINE / URGENT_CARE.',
				instructions: `You DO NOT DIAGNOSE.

YOUR ONLY JOB: match the described symptom to one of:
- SELF_CARE (mild, common, self-resolving)
- SCHEDULE_VISIT (non-urgent, needs provider)
- NURSE_LINE (needs same-day clinical judgment)
- URGENT_CARE (needs care today)

Use the triage knowledge base — don't infer beyond what it says.

When in doubt, ESCALATE ONE TIER. False positives are cheap; missed
positives are expensive.

(The runtime catches EMERGENCY before you see it — you never need to
worry about that tier.)

Format: state the tier in ONE sentence, then explain in ONE more
sentence. Do not list other tiers.

DO NOT use task() — you ARE the specialist.`,
				thinkingLevel: 'high',
			},
			billing: {
				name: 'billing',
				description:
					'Billing questions, insurance eligibility, dispute filing.',
				instructions: `You handle billing questions.

OPERATING RULES:
- NEVER quote insurance coverage from memory — ALWAYS call
  mcp__billing__verify_insurance first and read back the result.
- NEVER negotiate a write-off — escalate to a billing team human.
- NEVER promise a payment plan — offer to connect them with billing.
- For disputes: call mcp__billing__file_dispute with the patient's
  stated reason; tell the patient the 5-business-day response SLA.
- DO NOT use task() — you ARE the specialist.`,
			},
		},

		mcp: [
			{ name: mocks.patientFhir.name, url: mocks.patientFhir.url },
			{ name: mocks.rx.name, url: mocks.rx.url },
			{ name: mocks.billing.name, url: mocks.billing.url },
		],

		knowledge: [
			workspaceBm25({
				name: 'cedar-protocols',
				paths: ['knowledge/**/*.md'],
				chunkSize: 600,
			}),
		],

		validators: [
			// RUNTIME emergency guard — preLLM, ZERO LLM cost, deterministic.
			// MUST come first so it fires before anything else.
			emergencyKeywordGuard(),
			// PII redaction — mask SSN/CC before the LLM sees it.
			piiRedaction({ phase: 'preLLM', mode: 'mask' }),
			// Soft identity-required nudge.
			identityRequiredGuard(),
			// Post-LLM safety check.
			safety({ phase: 'postLLM' }),
		],

		memory: {
			service: new InMemoryMemoryService(),
			preload: { maxTokens: 400 },
			ingest: { auto: true, strategy: 'extract' },
		},

		resolveUserId(input) {
			const meta = input.metadata as { verifiedPatientId?: string; userId?: string } | undefined;
			// HARD requirement in production: only set userId from
			// verifiedPatientId (NEVER phone-alone). Memory must never
			// bridge unverified callers.
			return meta?.verifiedPatientId ?? meta?.userId;
		},

		compaction: { reserveTokens: 8000, keepRecentTokens: 4000 },
	});

	return { assistant, mocks };
}
