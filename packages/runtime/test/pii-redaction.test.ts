import { describe, expect, it } from 'vitest';
import { piiRedaction, redactString } from '../src/validators/pii-redaction.ts';
import { mockSession } from './_helpers.ts';
import { freshState } from '../src/state.ts';

describe('PII redaction validator', () => {
	const validatorCtx = () => ({
		session: mockSession(),
		state: freshState({ assistantName: 'support', channelName: 'web' }),
	});

	it('masks emails by default in preLLM', async () => {
		const v = piiRedaction();
		const result = await Promise.resolve(
			v.validate({ userMessage: 'Reach me at jane@example.com please' }, validatorCtx()),
		);
		expect('rewrite' in result).toBe(true);
		if ('rewrite' in result) {
			expect(result.rewrite).toBe('Reach me at [REDACTED_EMAIL] please');
		}
	});

	it('masks SSN', async () => {
		const v = piiRedaction();
		const result = await Promise.resolve(
			v.validate({ userMessage: 'My SSN is 123-45-6789 confidential' }, validatorCtx()),
		);
		if ('rewrite' in result) {
			expect(result.rewrite).toContain('[REDACTED_SSN]');
			expect(result.rewrite).not.toContain('123-45-6789');
		} else {
			expect.fail('expected rewrite');
		}
	});

	it('hash strategy produces deterministic placeholders', async () => {
		const v = piiRedaction({ strategy: 'hash' });
		const r1 = await Promise.resolve(v.validate({ userMessage: 'email a@b.com' }, validatorCtx()));
		const r2 = await Promise.resolve(v.validate({ userMessage: 'email a@b.com' }, validatorCtx()));
		if ('rewrite' in r1 && 'rewrite' in r2) {
			expect(r1.rewrite).toBe(r2.rewrite);
			expect(r1.rewrite).toMatch(/\[EMAIL_[0-9a-f]{8}\]/);
		} else {
			expect.fail('expected rewrites');
		}
	});

	it('remove strategy strips the match entirely', async () => {
		const v = piiRedaction({ strategy: 'remove', categories: ['email'] });
		const r = await Promise.resolve(v.validate({ userMessage: 'Contact: a@b.com.' }, validatorCtx()));
		if ('rewrite' in r) {
			expect(r.rewrite).toBe('Contact: .');
		} else {
			expect.fail('expected rewrite');
		}
	});

	it('categories: limits which patterns run', async () => {
		const v = piiRedaction({ categories: ['email'] });
		const r = await Promise.resolve(
			v.validate({ userMessage: 'email a@b.com phone 555-123-4567' }, validatorCtx()),
		);
		if ('rewrite' in r) {
			expect(r.rewrite).toContain('[REDACTED_EMAIL]');
			expect(r.rewrite).toContain('555-123-4567'); // phone NOT redacted
		} else {
			expect.fail('expected rewrite');
		}
	});

	it('passes through clean input as ok', async () => {
		const v = piiRedaction();
		const r = await Promise.resolve(
			v.validate({ userMessage: 'hello world no sensitive data here' }, validatorCtx()),
		);
		expect(r).toEqual({ ok: true });
	});

	it('postLLM phase redacts assistant text', async () => {
		const v = piiRedaction({ phase: 'postLLM' });
		const r = await Promise.resolve(
			v.validate(
				{ userMessage: 'irrelevant', assistantText: 'Your contact: jane@example.com' },
				validatorCtx(),
			),
		);
		if ('rewrite' in r) {
			expect(r.rewrite).toBe('Your contact: [REDACTED_EMAIL]');
		} else {
			expect.fail('expected rewrite');
		}
	});

	it('credit-card numbers are matched', () => {
		const out = redactString(
			'card 4111 1111 1111 1111 done',
			[{ category: 'credit-card', pattern: /\b4\d{3}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g }],
		);
		expect(out).toBe('card [REDACTED_CREDIT-CARD] done');
	});

	it('additionalPatterns extend detector', async () => {
		const v = piiRedaction({
			categories: [],
			additionalPatterns: [{ category: 'casenum', pattern: /CASE-\d{4,}/g }],
		});
		const r = await Promise.resolve(
			v.validate({ userMessage: 'Ticket CASE-12345 escalate' }, validatorCtx()),
		);
		if ('rewrite' in r) {
			expect(r.rewrite).toBe('Ticket [REDACTED_CASENUM] escalate');
		} else {
			expect.fail('expected rewrite');
		}
	});
});
