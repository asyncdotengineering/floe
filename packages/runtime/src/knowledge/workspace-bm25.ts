/**
 * Workspace BM25 KnowledgeSource.
 *
 * Reads markdown (or text) files from the session sandbox, chunks them by
 * paragraph (or by heading section), builds an in-memory BM25 index, and
 * returns scored chunks per query.
 *
 * Production-grade for v1 use:
 *   - Real BM25 with k1=1.5, b=0.75 (standard parameters)
 *   - Stopword filtering
 *   - Stemming (Porter-light: lowercase + strip trailing 's', 'ed', 'ing')
 *   - Section-based chunking (split on # headers when available; fall back
 *     to paragraph + size-based chunking)
 *   - Score normalization to 0..1
 *
 * Limitations (documented):
 *   - No embeddings; pure lexical. For semantic search, swap in a different
 *     KnowledgeSource (the interface is two methods).
 *   - Built once at prepare(); no incremental updates. The sandbox in Flue
 *     is per-conversation so this is fine for chat; a long-lived process
 *     would want a watch loop.
 */
import type { FlueSession } from '@flue/runtime';
import { defineKnowledgeSource } from '../define.ts';
import type { KnowledgeChunk, KnowledgeSource } from '../types.ts';
import { chunkMarkdown as headingScoredChunkMarkdown } from '../chunkers/markdown.ts';

const BM25_K1 = 1.5;
const BM25_B = 0.75;

const STOPWORDS = new Set([
	'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
	'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
	'should', 'may', 'might', 'can', 'and', 'or', 'but', 'not', 'no',
	'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as',
	'this', 'that', 'these', 'those', 'it', 'its', 'i', 'you', 'he', 'she',
	'we', 'they', 'them', 'their', 'his', 'her', 'me', 'us', 'my', 'your',
	'our', 'so', 'if', 'than', 'then', 'because', 'while', 'about', 'into',
	'over', 'under', 'up', 'down', 'out', 'off',
]);

export interface WorkspaceBm25Options {
	/** Source identifier returned in chunks. Default: 'workspace'. */
	name?: string;
	/**
	 * Glob-like paths (relative to the sandbox cwd) to read. Default:
	 * `['**\/*.md']`. Comma-separated extensions in `**\/*.{md,txt}` style work.
	 * Globbing is simple — single `**\/*.<ext>` is supported.
	 */
	paths?: string[];
	/** Target characters per chunk after splitting. Default 500. */
	chunkSize?: number;
	/** Min characters per chunk. Default 80. */
	minChunkSize?: number;
}

interface Doc {
	id: string;
	source: string;
	text: string;
	tokens: string[];
	termFreq: Map<string, number>;
	length: number;
}

interface IndexState {
	docs: Doc[];
	avgDocLength: number;
	df: Map<string, number>;
	totalDocs: number;
}

export function workspaceBm25(opts: WorkspaceBm25Options = {}): KnowledgeSource {
	const sourceName = opts.name ?? 'workspace';
	const paths = opts.paths ?? ['**/*.md'];
	const chunkSize = opts.chunkSize ?? 500;
	const minChunkSize = opts.minChunkSize ?? 80;

	let index: IndexState | null = null;
	let prepared = false;

	return defineKnowledgeSource({
		name: sourceName,

		async prepare(session: FlueSession): Promise<void> {
			if (prepared) return;
			prepared = true;

			const files = await collectFiles(session, paths);
			if (process.env.FLOE_DEBUG === '1') {
				console.error(
					`[floe:bm25] ${sourceName}: paths=${JSON.stringify(paths)} → ${files.length} files: ${files.join(', ')}`,
				);
			}
			const docs: Doc[] = [];
			for (const filePath of files) {
				try {
					const content = await session.fs.readFile(filePath);
					const chunks = chunkMarkdown(content, chunkSize, minChunkSize);
					for (let i = 0; i < chunks.length; i++) {
						const text = chunks[i]!;
						const tokens = tokenize(text);
						const termFreq = new Map<string, number>();
						for (const t of tokens) {
							termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
						}
						docs.push({
							id: `${filePath}#${i}`,
							source: filePath,
							text,
							tokens,
							termFreq,
							length: tokens.length,
						});
					}
				} catch (err) {
					console.error(
						`[floe:workspace-bm25] failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}

			const totalDocs = docs.length;
			const avgDocLength =
				totalDocs === 0
					? 0
					: docs.reduce((acc, d) => acc + d.length, 0) / totalDocs;

			const df = new Map<string, number>();
			for (const d of docs) {
				for (const term of new Set(d.tokens)) {
					df.set(term, (df.get(term) ?? 0) + 1);
				}
			}

			index = { docs, avgDocLength, df, totalDocs };
		},

		async search(query, queryOpts): Promise<KnowledgeChunk[]> {
			if (!index || index.totalDocs === 0) return [];
			const limit = queryOpts?.limit ?? 5;
			const threshold = queryOpts?.threshold ?? 0;

			const qTokens = Array.from(new Set(tokenize(query)));
			if (qTokens.length === 0) return [];

			const scores = new Map<number, number>();
			for (let i = 0; i < index.docs.length; i++) {
				const d = index.docs[i]!;
				let score = 0;
				for (const term of qTokens) {
					const tf = d.termFreq.get(term);
					if (!tf) continue;
					const docFreq = index.df.get(term) ?? 0;
					const idf = Math.log(
						(index.totalDocs - docFreq + 0.5) / (docFreq + 0.5) + 1,
					);
					const norm =
						1 - BM25_B + BM25_B * (d.length / (index.avgDocLength || 1));
					score += idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm));
				}
				if (score > 0) scores.set(i, score);
			}

			const ranked = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
			if (ranked.length === 0) return [];

			// Normalize the top score to 1.0 for comparable scores across queries.
			const topScore = ranked[0]![1];
			const out: KnowledgeChunk[] = [];
			for (const [docIdx, rawScore] of ranked.slice(0, limit)) {
				const normalized = topScore === 0 ? 0 : rawScore / topScore;
				if (normalized < threshold) break;
				const d = index.docs[docIdx]!;
				out.push({
					id: d.id,
					text: d.text,
					source: d.source,
					score: normalized,
					metadata: { rawScore },
				});
			}
			return out;
		},
	});
}

// ─── Helpers ───────────────────────────────────────────────────────────────

async function collectFiles(session: FlueSession, paths: string[]): Promise<string[]> {
	const out = new Set<string>();
	for (const pattern of paths) {
		const matches = await expandGlob(session, pattern);
		for (const m of matches) out.add(m);
	}
	return Array.from(out).sort();
}

/**
 * Minimal globbing. Supports:
 *   - `**\/*.<ext>`            — walk cwd recursively for files with extension
 *   - `<dir>/**\/*.<ext>`      — walk <dir> recursively for files with extension
 *   - `<dir>/*.<ext>`          — files with extension directly in <dir>
 *   - bare file path           — single file
 *
 * Anything more complex: list paths explicitly in opts.paths.
 */
async function expandGlob(session: FlueSession, pattern: string): Promise<string[]> {
	// <dir>/**/*.<ext>
	let m = pattern.match(/^(.+?)\/\*\*\/\*\.(\w+)$/);
	if (m) {
		const dir = m[1]!;
		const ext = m[2]!;
		if (process.env.FLOE_DEBUG === '1') {
			console.error(`[floe:bm25] expandGlob "${pattern}" → walk("${dir}", ".${ext}")`);
		}
		return walkForExtension(session, dir, ext);
	}
	// **/*.<ext> (no dir prefix)
	m = pattern.match(/^\*\*\/\*\.(\w+)$/);
	if (m) return walkForExtension(session, '.', m[1]!);
	// <dir>/*.<ext>
	m = pattern.match(/^(.+?)\/\*\.(\w+)$/);
	if (m) return listExtension(session, m[1]!, m[2]!);
	// Literal path
	try {
		const exists = await session.fs.exists(pattern);
		return exists ? [pattern] : [];
	} catch {
		return [];
	}
}

async function listExtension(
	session: FlueSession,
	dir: string,
	ext: string,
): Promise<string[]> {
	const out: string[] = [];
	let entries: string[];
	try {
		entries = await session.fs.readdir(dir);
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (!entry.endsWith(`.${ext}`)) continue;
		const full = `${dir}/${entry}`;
		try {
			const stat = await session.fs.stat(full);
			if (stat.isFile) out.push(full);
		} catch {
			/* skip */
		}
	}
	return out;
}

async function walkForExtension(
	session: FlueSession,
	dir: string,
	ext: string,
): Promise<string[]> {
	const out: string[] = [];
	let entries: string[];
	try {
		entries = await session.fs.readdir(dir);
	} catch (err) {
		if (process.env.FLOE_DEBUG === '1') {
			console.error(
				`[floe:bm25] readdir("${dir}") failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		return out;
	}
	for (const entry of entries) {
		const full = dir === '.' ? entry : `${dir}/${entry}`;
		try {
			const stat = await session.fs.stat(full);
			if (stat.isDirectory) {
				const nested = await walkForExtension(session, full, ext);
				out.push(...nested);
			} else if (stat.isFile && entry.endsWith(`.${ext}`)) {
				out.push(full);
			}
		} catch {
			// permission/missing — skip
		}
	}
	return out;
}

function chunkMarkdown(
	content: string,
	targetSize: number,
	minSize: number,
): string[] {
	// Delegates to the heading-scored chunker (see `chunkers/markdown.ts`).
	// Ported from qmd's BREAK_PATTERNS + findBestCutoff with squared-distance
	// decay — materially better chunk boundaries than the previous
	// paragraph splitter, at no runtime cost.
	return headingScoredChunkMarkdown(content, {
		targetChars: targetSize,
		minChars: minSize,
	});
}

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^\w\s]/g, ' ')
		.split(/\s+/)
		.filter((t) => t.length > 1 && !STOPWORDS.has(t))
		.map(stem);
}

function stem(t: string): string {
	if (t.endsWith('ing') && t.length > 5) return t.slice(0, -3);
	if (t.endsWith('ed') && t.length > 4) return t.slice(0, -2);
	if (t.endsWith('s') && !t.endsWith('ss') && t.length > 3) return t.slice(0, -1);
	return t;
}
