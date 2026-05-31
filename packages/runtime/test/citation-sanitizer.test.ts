/**
 * Citation sanitizer — stripping behavior across all three modes,
 * with focus on the chunk-spanning cases the streaming layer hits.
 */
import { describe, expect, it } from 'vitest';
import {
	createCitationSanitizer,
	type CitationMode,
} from '../src/streaming/citation-sanitizer.ts';

function run(mode: CitationMode, chunks: string[]): string {
	const s = createCitationSanitizer(mode);
	let out = '';
	for (const c of chunks) out += s.push(c);
	out += s.flush();
	return out;
}

describe('citation sanitizer — single-chunk inputs', () => {
	describe("mode 'optional'", () => {
		it.each([
			['pure integer kept', 'See [3] for details.', 'See [3] for details.'],
			['multiple integers kept', 'See [1, 3, 5].', 'See [1, 3, 5].'],
			[
				'tool-name bracket stripped',
				'It costs $7 [checkPlanPricing].',
				'It costs $7 .',
			],
			[
				'mixed numeric+name stripped',
				'See [2, checkPlanPricing] for details.',
				'See  for details.',
			],
			[
				'free-form bracket stripped',
				'Try this [important note].',
				'Try this .',
			],
			['empty bracket stripped', 'Hmm [] really?', 'Hmm  really?'],
			['no brackets at all unchanged', 'Just plain text.', 'Just plain text.'],
			[
				'multiple citations in one sentence',
				'See [1] and [foo] and [2].',
				'See [1] and  and [2].',
			],
		])('%s', (_label, input, expected) => {
			expect(run('optional', [input])).toBe(expected);
		});
	});

	describe("mode 'required'", () => {
		it('keeps numeric, strips non-numeric (same rule as optional)', () => {
			expect(run('required', ['Hi [3] [foo]'])).toBe('Hi [3] ');
		});
	});

	describe("mode 'off'", () => {
		it('strips ALL brackets including numeric', () => {
			expect(run('off', ['See [3] and [foo].'])).toBe('See  and .');
		});
	});
});

describe('citation sanitizer — chunk-boundary cases (streaming reality)', () => {
	it("bracket opens at end of one chunk, closes in the next ('optional')", () => {
		expect(run('optional', ['Hi [', '3', '] there'])).toBe('Hi [3] there');
	});

	it('bracket spans many tiny chunks (per-char)', () => {
		const chars = 'Hi [checkPlanPricing] you'.split('');
		expect(run('optional', chars)).toBe('Hi  you');
	});

	it('numeric bracket spans tiny chunks', () => {
		expect(run('optional', ['x', ' ', '[', '4', '2', ']', ' y'])).toBe(
			'x [42] y',
		);
	});

	it('open bracket with no close → flushed as raw at stream end', () => {
		expect(run('optional', ['Trailing ['])).toBe('Trailing [');
	});

	it('open bracket with partial content → flushed as raw at stream end', () => {
		expect(run('optional', ['Trailing [abc'])).toBe('Trailing [abc');
	});

	it('runaway open bracket past BUFFER_CAP flushes as raw mid-stream', () => {
		const long = 'x'.repeat(150);
		expect(run('optional', [`Hi [${long}`])).toContain('[' + 'x'.repeat(100));
	});

	it('"off" still strips across chunk boundaries', () => {
		expect(run('off', ['See [', '3', '] now'])).toBe('See  now');
	});
});

describe('citation sanitizer — typical model outputs', () => {
	it('the canonical gemini failure: mixed numeric+toolname inside one bracket', () => {
		const input =
			'Standard shipping is $7 [2, checkPlanPricing]. Other details apply [1].';
		// First bracket: stripped (has non-numeric). Second: kept (pure numeric).
		expect(run('optional', [input])).toBe(
			'Standard shipping is $7 . Other details apply [1].',
		);
	});

	it('the alice-lookup case from the real bug report', () => {
		const input =
			'Alice is on Pro [checkAccount] and Enterprise has SSO [checkPlanPricing].';
		expect(run('optional', [input])).toBe(
			'Alice is on Pro  and Enterprise has SSO .',
		);
	});
});
