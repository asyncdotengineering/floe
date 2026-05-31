/**
 * Boundary tests for the SentenceStreamer. Voice TTS quality hinges
 * on these — wrong-sized chunks produce unnatural prosody.
 */
import { describe, expect, it } from 'vitest';
import { SentenceStreamer } from '../src/sentence-stream.ts';

describe('SentenceStreamer', () => {
	it('flushes one sentence on period+space', () => {
		const s = new SentenceStreamer();
		const out = s.push('Got it. ');
		expect(out.map((o) => o.sentence)).toEqual(['Got it.']);
	});

	it('buffers mid-sentence chunks until boundary', () => {
		const s = new SentenceStreamer();
		expect(s.push('Got ')).toEqual([]);
		expect(s.push('it')).toEqual([]);
		expect(s.push('. ').map((o) => o.sentence)).toEqual(['Got it.']);
	});

	it('flushes multiple sentences in one push', () => {
		const s = new SentenceStreamer();
		const out = s.push('Hi there. How can I help? I am ready.');
		expect(out.map((o) => o.sentence)).toEqual([
			'Hi there.',
			'How can I help?',
			'I am ready.',
		]);
	});

	it('handles ! and ? boundaries', () => {
		const s = new SentenceStreamer();
		const out = s.push('Wow! Really? Yes.');
		expect(out.map((o) => o.sentence)).toEqual(['Wow!', 'Really?', 'Yes.']);
	});

	it('paragraph break forces flush', () => {
		const s = new SentenceStreamer();
		const out = s.push('First line.\n\nSecond line');
		expect(out.map((o) => o.sentence)).toEqual(['First line.']);
	});

	it('flush() returns trailing buffer as finalRemainder', () => {
		const s = new SentenceStreamer();
		s.push('No terminator yet');
		const out = s.flush();
		expect(out).toEqual([{ sentence: 'No terminator yet', finalRemainder: true }]);
	});

	it('flush() returns empty when buffer is empty', () => {
		const s = new SentenceStreamer();
		s.push('Done. ');
		expect(s.flush()).toEqual([]);
	});

	it('quoted-period boundaries still flush', () => {
		const s = new SentenceStreamer();
		const out = s.push('She said "hello." Then she left.');
		expect(out.map((o) => o.sentence)).toContain('She said "hello."');
	});
});
