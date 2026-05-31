/**
 * The make-or-break test for cedar-health: the emergency keyword guard
 * MUST short-circuit before any LLM call. Tests the guard in
 * isolation (no Assistant boot, no MCP, no LLM) so it stays fast +
 * deterministic.
 *
 * Every emergency pattern in DEFAULT_EMERGENCY_PATTERNS gets one
 * positive example. False-positive tolerance is intentional and the
 * test ALSO verifies a few near-misses to pin the regex shape.
 */
import { describe, expect, it } from 'vitest';
import { emergencyKeywordGuard } from '../guards/emergency.ts';
import type { ValidatorContext } from '@floe/runtime';

const fakeCtx = {} as ValidatorContext;

async function check(message: string) {
	const guard = emergencyKeywordGuard();
	return await guard.validate({ userMessage: message }, fakeCtx);
}

describe('emergencyKeywordGuard — positive matches', () => {
	const POSITIVES = [
		"I'm having some chest pain and I'm not sure what to do.",
		"I can't breathe well, it's been like this for an hour",
		"I'm having difficulty breathing since this morning",
		"My partner is unconscious",
		"Someone in my house is passing out",
		"I'm having suicidal thoughts",
		"My nose won't stop bleeding heavily",
		"My face is drooping and my speech is slurred",
		"I think it's a stroke",
		"They took an overdose of pills",
		"He's not responsive, I can't wake him up",
		"I think I'm having a severe allergic reaction",
		"Anaphylaxis — my throat is closing",
	];
	for (const message of POSITIVES) {
		it(`matches: "${message.slice(0, 40)}…"`, async () => {
			const result = await check(message);
			expect('escalate' in result ? result.escalate : null).not.toBeNull();
			expect('escalate' in result ? result.escalate.to : '').toBe('911');
			// Scripted reply present + 911 mentioned
			const reason = 'escalate' in result ? result.escalate.reason : '';
			expect(reason).toMatch(/911/);
		});
	}
});

describe('emergencyKeywordGuard — negatives (non-emergency)', () => {
	const NEGATIVES = [
		"I'd like to reschedule my appointment with Dr. Chen",
		"Can I get a refill for my lisinopril",
		"How much is the copay for an annual physical",
		"My back has been sore for a few days, what should I do",
		"I have a mild headache, I think I just need water",
	];
	for (const message of NEGATIVES) {
		it(`does NOT match: "${message.slice(0, 40)}…"`, async () => {
			const result = await check(message);
			expect('ok' in result && result.ok === true).toBe(true);
		});
	}
});

describe('emergencyKeywordGuard — customization', () => {
	it('uses custom scripted reply when provided', async () => {
		const guard = emergencyKeywordGuard({
			scriptedReply: 'Custom 911 message here.',
		});
		const result = await guard.validate({ userMessage: 'chest pain' }, fakeCtx);
		expect('escalate' in result ? result.escalate.reason : '').toBe(
			'Custom 911 message here.',
		);
	});
	it('uses custom escalateTo target', async () => {
		const guard = emergencyKeywordGuard({ escalateTo: 'nurse-stat' });
		const result = await guard.validate({ userMessage: 'chest pain' }, fakeCtx);
		expect('escalate' in result ? result.escalate.to : '').toBe('nurse-stat');
	});
	it('uses custom pattern list', async () => {
		const guard = emergencyKeywordGuard({ patterns: [/yikes/i] });
		const yikes = await guard.validate({ userMessage: 'yikes' }, fakeCtx);
		expect('escalate' in yikes).toBe(true);
		const chest = await guard.validate({ userMessage: 'chest pain' }, fakeCtx);
		expect('ok' in chest && chest.ok === true).toBe(true);
	});
});
