/**
 * Streaming sanitizer for citation brackets in assistant text.
 *
 * Why this exists: even with explicit prompt guidance ("do NOT bracket-cite
 * tool outputs"), weaker models — observed with gemini-3.5-flash — still
 * produce non-numeric citation brackets ~33% of the time, e.g.
 * `[checkPlanPricing]` or `[2, checkPlanPricing]`. The user-visible result
 * is a poisoned audit trail for compliance use cases that depend on
 * `citations: 'required'`. Prompt-only fixes are stochastic; this is the
 * deterministic layer.
 *
 * Design: a stateful per-stream transformer that runs INSIDE the SSE
 * encoder pipeline. When it sees `[` it enters buffering mode, accumulates
 * the bracket contents until `]` arrives, then decides whether to emit
 * the bracket based on the active citation mode:
 *
 *   - `'off'`              → strip ALL `[...]` brackets (matches prompt).
 *   - `'optional' | 'required'` → keep `[3]` / `[2, 5]` (pure-numeric);
 *                                 strip anything else (`[checkPlanPricing]`,
 *                                 `[2, checkPlanPricing]`, `[important note]`).
 *
 * Tradeoffs:
 *   - If the model legitimately quotes user text containing brackets (e.g.
 *     user wrote "I want to see [pricing]" and bot quotes it back), the
 *     quoted brackets ARE stripped. Acceptable for citation contexts.
 *   - Buffer cap is 100 chars to bound memory/latency for runaway `[`
 *     without a matching `]`. Past the cap, we give up and flush as raw.
 *   - Stream-end without matching `]` flushes the buffered text as raw.
 *
 * Tested in:  packages/runtime/test/citation-sanitizer.test.ts
 * Wired in :  packages/runtime/src/streaming/mux.ts (per-stream instance)
 */
export type CitationMode = 'required' | 'optional' | 'off';

export interface CitationSanitizer {
	/** Push a text chunk through. Returns the sanitized text safe to emit. */
	push(text: string): string;
	/** Drain any buffered text at end of stream (e.g. unterminated `[`). */
	flush(): string;
}

const PURE_NUMERIC = /^\s*\d+(?:\s*,\s*\d+)*\s*$/;
const BUFFER_CAP = 100;

export function createCitationSanitizer(mode: CitationMode): CitationSanitizer {
	let buffer = '';
	let inBracket = false;

	const shouldKeep = (content: string): boolean => {
		if (mode === 'off') return false; // strip every bracket
		return PURE_NUMERIC.test(content); // optional/required: keep only numeric
	};

	return {
		push(text: string): string {
			let out = '';
			for (let i = 0; i < text.length; i++) {
				const ch = text[i]!;
				if (!inBracket) {
					if (ch === '[') {
						inBracket = true;
						buffer = '';
					} else {
						out += ch;
					}
					continue;
				}
				if (ch === ']') {
					if (shouldKeep(buffer)) {
						out += '[' + buffer + ']';
					}
					inBracket = false;
					buffer = '';
					continue;
				}
				if (buffer.length >= BUFFER_CAP) {
					// Runaway open-bracket — give up and flush as raw text.
					out += '[' + buffer + ch;
					inBracket = false;
					buffer = '';
					continue;
				}
				buffer += ch;
			}
			return out;
		},
		flush(): string {
			if (!inBracket) return '';
			const leftover = '[' + buffer;
			inBracket = false;
			buffer = '';
			return leftover;
		},
	};
}
