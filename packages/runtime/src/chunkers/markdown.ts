/**
 * Heading-scored markdown chunker.
 *
 * Ported with attribution from Tobi Lutke's qmd
 * (https://github.com/tobi/qmd, MIT) — specifically `src/store.ts` lines
 * 115-325. We reproduce the scoring rubric verbatim because it represents
 * a body of empirical tuning we'd otherwise have to redo:
 *
 *   - H1 → 100, H2 → 90, H3 → 80, H4 → 70, H5 → 60, H6 → 50
 *   - codeblock fence → 80
 *   - hr (---, ***, ___) → 60
 *   - blank line → 20
 *   - list item → 5
 *   - newline → 1
 *
 * Within a window of N chars before the target cut, each candidate
 * break-point's score decays with squared distance. This lets a heading
 * that's 75% back still beat a near-blank-line — empirically gives the
 * cleanest chunk boundaries on real markdown.
 *
 * Code-fence aware: we never split inside a ``` block.
 *
 * Output is `string[]` so it's a drop-in replacement for the previous
 * paragraph-based `chunkMarkdown()` in workspace-bm25. Callers that need
 * chunk start positions can call `chunkMarkdownWithPositions` instead.
 */

interface BreakPoint {
	pos: number;
	score: number;
	type: string;
}

interface CodeFenceRegion {
	start: number;
	end: number;
}

/** qmd line 115-128. Lower indices have higher precedence on ties. */
const BREAK_PATTERNS: ReadonlyArray<readonly [RegExp, number, string]> = [
	[/\n#{1}(?!#)/g, 100, 'h1'],
	[/\n#{2}(?!#)/g, 90, 'h2'],
	[/\n#{3}(?!#)/g, 80, 'h3'],
	[/\n#{4}(?!#)/g, 70, 'h4'],
	[/\n#{5}(?!#)/g, 60, 'h5'],
	[/\n#{6}(?!#)/g, 50, 'h6'],
	[/\n```/g, 80, 'codeblock'],
	[/\n(?:---|\*\*\*|___)\s*\n/g, 60, 'hr'],
	[/\n\n+/g, 20, 'blank'],
	[/\n[-*]\s/g, 5, 'list'],
	[/\n\d+\.\s/g, 5, 'numlist'],
	[/\n/g, 1, 'newline'],
];

export interface ChunkOptions {
	/**
	 * Target chunk size in CHARS. Tokens are approximately chars/4, so the
	 * qmd-default 900 tokens ≈ 3600 chars. Defaults to 1200 chars
	 * (~300 tokens) which is a better fit for chat retrieval; bigger
	 * chunks bury the relevant detail.
	 */
	targetChars?: number;
	/** Overlap between adjacent chunks in chars. Default 15% of targetChars. */
	overlapChars?: number;
	/** Cut-search window in chars (look back N chars for the best break). Default 25% of targetChars. */
	windowChars?: number;
	/** Decay factor for squared-distance scoring. qmd default 0.7. */
	decayFactor?: number;
	/** Minimum chars per chunk; chunks shorter than this are dropped. Default 40. */
	minChars?: number;
}

const DEFAULT_TARGET_CHARS = 1200;
const DEFAULT_DECAY_FACTOR = 0.7;
const DEFAULT_MIN_CHARS = 40;

export interface Chunk {
	text: string;
	/** Char offset in the original document where this chunk starts. */
	pos: number;
}

/** Drop-in replacement for the old paragraph-based chunker. */
export function chunkMarkdown(content: string, opts: ChunkOptions = {}): string[] {
	return chunkMarkdownWithPositions(content, opts).map((c) => c.text);
}

export function chunkMarkdownWithPositions(content: string, opts: ChunkOptions = {}): Chunk[] {
	const target = opts.targetChars ?? DEFAULT_TARGET_CHARS;
	const overlap = opts.overlapChars ?? Math.floor(target * 0.15);
	const window = opts.windowChars ?? Math.floor(target * 0.25);
	const decay = opts.decayFactor ?? DEFAULT_DECAY_FACTOR;
	const minChars = opts.minChars ?? DEFAULT_MIN_CHARS;

	if (content.length <= target) {
		return content.trim().length >= minChars ? [{ text: content, pos: 0 }] : [];
	}

	const breakPoints = scanBreakPoints(content);
	const fences = findCodeFences(content);
	const raw = chunkWithBreakPoints(content, breakPoints, fences, target, overlap, window, decay);
	return raw.filter((c) => c.text.trim().length >= minChars);
}

function scanBreakPoints(text: string): BreakPoint[] {
	const seen = new Map<number, BreakPoint>();
	for (const [pattern, score, type] of BREAK_PATTERNS) {
		for (const match of text.matchAll(pattern)) {
			const pos = match.index ?? -1;
			if (pos < 0) continue;
			const existing = seen.get(pos);
			if (!existing || score > existing.score) {
				seen.set(pos, { pos, score, type });
			}
		}
	}
	return Array.from(seen.values()).sort((a, b) => a.pos - b.pos);
}

function findCodeFences(text: string): CodeFenceRegion[] {
	const regions: CodeFenceRegion[] = [];
	const fence = /\n```/g;
	let inFence = false;
	let start = 0;
	for (const match of text.matchAll(fence)) {
		if (!inFence) {
			start = match.index!;
			inFence = true;
		} else {
			regions.push({ start, end: match.index! + match[0].length });
			inFence = false;
		}
	}
	if (inFence) regions.push({ start, end: text.length });
	return regions;
}

function isInsideCodeFence(pos: number, fences: CodeFenceRegion[]): boolean {
	for (const f of fences) {
		if (pos > f.start && pos < f.end) return true;
	}
	return false;
}

/**
 * qmd `findBestCutoff` line 206-242. Squared distance decay; far-back
 * high-quality breaks beat near-by low-quality ones.
 */
function findBestCutoff(
	breakPoints: BreakPoint[],
	targetCharPos: number,
	windowChars: number,
	decayFactor: number,
	codeFences: CodeFenceRegion[],
): number {
	const windowStart = targetCharPos - windowChars;
	let bestScore = -1;
	let bestPos = targetCharPos;
	for (const bp of breakPoints) {
		if (bp.pos < windowStart) continue;
		if (bp.pos > targetCharPos) break;
		if (isInsideCodeFence(bp.pos, codeFences)) continue;
		const distance = targetCharPos - bp.pos;
		const norm = distance / windowChars;
		const multiplier = 1 - norm * norm * decayFactor;
		const finalScore = bp.score * multiplier;
		if (finalScore > bestScore) {
			bestScore = finalScore;
			bestPos = bp.pos;
		}
	}
	return bestPos;
}

function chunkWithBreakPoints(
	content: string,
	breakPoints: BreakPoint[],
	codeFences: CodeFenceRegion[],
	maxChars: number,
	overlapChars: number,
	windowChars: number,
	decayFactor: number,
): Chunk[] {
	if (content.length <= maxChars) return [{ text: content, pos: 0 }];
	const out: Chunk[] = [];
	let charPos = 0;
	while (charPos < content.length) {
		const targetEnd = Math.min(charPos + maxChars, content.length);
		let endPos = targetEnd;
		if (endPos < content.length) {
			const cutoff = findBestCutoff(breakPoints, targetEnd, windowChars, decayFactor, codeFences);
			if (cutoff > charPos && cutoff <= targetEnd) endPos = cutoff;
		}
		if (endPos <= charPos) endPos = Math.min(charPos + maxChars, content.length);
		out.push({ text: content.slice(charPos, endPos), pos: charPos });
		if (endPos >= content.length) break;
		const lastPos = out.at(-1)!.pos;
		charPos = endPos - overlapChars;
		if (charPos <= lastPos) charPos = endPos;
	}
	return out;
}
