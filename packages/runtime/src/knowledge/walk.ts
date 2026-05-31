/**
 * Sandbox filesystem walking + minimal glob expansion. Shared by
 * `workspace-bm25` and `hybrid` knowledge sources so both index the same
 * set of files from the same input patterns.
 *
 * Supported glob patterns (kept intentionally small — power-glob is
 * future scope; users with complex patterns enumerate files explicitly):
 *
 *   - `<dir>/**\/*.<ext>`   — walk dir recursively
 *   - `**\/*.<ext>`         — walk cwd recursively
 *   - `<dir>/*.<ext>`       — list dir non-recursively
 *   - literal file path     — single file
 */
import type { FlueSession } from '@flue/runtime';

export async function collectFiles(
	session: FlueSession,
	paths: string[],
): Promise<string[]> {
	const out = new Set<string>();
	for (const pattern of paths) {
		const matches = await expandGlob(session, pattern);
		for (const m of matches) out.add(m);
	}
	return Array.from(out).sort();
}

async function expandGlob(session: FlueSession, pattern: string): Promise<string[]> {
	let m = pattern.match(/^(.+?)\/\*\*\/\*\.(\w+)$/);
	if (m) return walkForExtension(session, m[1]!, m[2]!);
	m = pattern.match(/^\*\*\/\*\.(\w+)$/);
	if (m) return walkForExtension(session, '.', m[1]!);
	m = pattern.match(/^(.+?)\/\*\.(\w+)$/);
	if (m) return listExtension(session, m[1]!, m[2]!);
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
	} catch {
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
			/* permission/missing — skip */
		}
	}
	return out;
}
