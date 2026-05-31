/**
 * Sentence-boundary stream wrapper.
 *
 * Voice TTS pipelines want sentence-shaped chunks: "Got it." flushes,
 * "Got it. Let me check that." also flushes (twice). Mid-sentence
 * chunks get buffered until the next punctuation+whitespace boundary.
 *
 * Why: smaller-than-sentence chunks cause unnatural TTS prosody (every
 * comma triggers a new audio segment); larger-than-sentence chunks
 * delay first audio. The sentence is the natural unit speech engines
 * expect.
 *
 * The boundary detector recognizes `.`, `!`, `?` followed by whitespace
 * or end-of-buffer, and treats `\n\n` as a hard flush (paragraph break).
 * Trailing buffer is flushed on stream end.
 */

const BOUNDARY_RE = /([.!?]["'')\]]?)(\s+|$)/;

export interface SentenceFlush {
	sentence: string;
	/** True when this is the trailing remainder flushed at end-of-stream. */
	finalRemainder: boolean;
}

export class SentenceStreamer {
	private buffer = '';

	push(chunk: string): SentenceFlush[] {
		this.buffer += chunk;
		const out: SentenceFlush[] = [];
		while (true) {
			// Hard paragraph break — flush everything before the double newline.
			const para = this.buffer.indexOf('\n\n');
			if (para >= 0) {
				const head = this.buffer.slice(0, para).trim();
				if (head) out.push({ sentence: head, finalRemainder: false });
				this.buffer = this.buffer.slice(para + 2);
				continue;
			}
			// Normal sentence boundary.
			const m = BOUNDARY_RE.exec(this.buffer);
			if (!m) break;
			const endIdx = m.index + m[1]!.length;
			const sentence = this.buffer.slice(0, endIdx).trim();
			if (sentence) out.push({ sentence, finalRemainder: false });
			this.buffer = this.buffer.slice(endIdx + (m[2]?.length ?? 0));
		}
		return out;
	}

	flush(): SentenceFlush[] {
		const rem = this.buffer.trim();
		this.buffer = '';
		if (!rem) return [];
		return [{ sentence: rem, finalRemainder: true }];
	}

	get pending(): string {
		return this.buffer;
	}
}
