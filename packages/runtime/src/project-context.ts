/**
 * Project context loader — the AGENTS.md pattern.
 *
 * Reads `<configDir>/AGENTS.md` (and `<configDir>/CLAUDE.md` if present)
 * once per Assistant boot, caches the concatenated content, and exposes
 * it via `loadProjectContext(configDir)`. The orchestrator passes the
 * result into `buildSystemPrompt` so the file's contents land in EVERY
 * turn's system prompt — the agents.md pattern Vercel's evals validate
 * (always-present beats decide-to-invoke by 47pp; tool-gated capabilities
 * see 56% non-invocation).
 *
 * Mirrors Flue's own discovery (`@flue/runtime/src/context.ts:readAgentsMd`)
 * but reads from the Assistant's `configDir` (the project root the user
 * passed to `new Assistant({configDir})`) rather than from the session's
 * sandbox cwd. This decouples Floe from Flue's session-cwd plumbing —
 * Floe takes ownership of the file's contents being in its OWN system
 * prompt block, where they're guaranteed to land instead of getting
 * silently dropped by the legacy `<system>`-in-user-message wrapping.
 *
 * Files read (in order, concatenated):
 *   1. AGENTS.md  — the canonical convention (Vercel, Anthropic, OpenAI)
 *   2. CLAUDE.md  — the legacy Claude convention; still common in repos
 *
 * Missing files are skipped silently. If neither exists, returns empty
 * string and the prompt builder omits the "# Project context" block.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const FILES = ['AGENTS.md', 'CLAUDE.md'] as const;

/**
 * Module-level cache keyed by configDir. Loading is async-once: every
 * subsequent caller for the same configDir gets the same in-flight or
 * resolved promise. Filesystem I/O happens at most once per
 * `(configDir × file)` pair for the process lifetime.
 *
 * Invalidation is intentionally absent — AGENTS.md is treated as a
 * deploy-time artifact, not a runtime configuration knob. If you edit
 * the file, restart the process (or your serverless cold-init does it
 * for you). This is consistent with how Flue itself treats it.
 */
const cache = new Map<string, Promise<string>>();

export function loadProjectContext(configDir: string | undefined): Promise<string> {
	if (!configDir) return Promise.resolve('');
	const cached = cache.get(configDir);
	if (cached) return cached;
	const loading = readFilesOnce(configDir);
	cache.set(configDir, loading);
	return loading;
}

/**
 * Test-only: drop the cache so a test can re-load with a different file
 * on disk. NEVER call from production code paths.
 */
export function _resetProjectContextCache(): void {
	cache.clear();
}

async function readFilesOnce(configDir: string): Promise<string> {
	const parts: string[] = [];
	for (const filename of FILES) {
		const filePath = join(configDir, filename);
		try {
			const content = await fs.readFile(filePath, 'utf8');
			const trimmed = content.trim();
			if (trimmed.length > 0) parts.push(trimmed);
		} catch (err) {
			// ENOENT is the expected case for missing files — silent.
			// Any other error (permissions, IO) we log once and continue;
			// missing project context is a degradation, not a failure.
			const code = (err as NodeJS.ErrnoException | undefined)?.code;
			if (code && code !== 'ENOENT') {
				console.warn(
					`[floe:project-context] failed to read ${filePath}: ${code}. Skipping.`,
				);
			}
		}
	}
	return parts.join('\n\n');
}
