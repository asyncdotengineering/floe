/**
 * Procedure body loader. Reads markdown from the session's sandbox at first
 * activation and caches the parsed metadata + body on the procedure object.
 *
 * Frontmatter format (YAML-ish, single-line key:value pairs):
 *
 *     ---
 *     name: refund-policy
 *     triggers: ["refund", "money back", "return policy"]
 *     escalate-when: "customer is angry or threatens chargeback"
 *     ---
 *
 *     # Refund Policy
 *     ...body...
 */
import type { FlueSession } from '@flue/runtime';
import type { Procedure, ProcedureMetadata } from './types.ts';

export async function loadProcedure(
	session: FlueSession,
	procedure: Procedure,
): Promise<{ metadata: ProcedureMetadata; body: string }> {
	if (procedure._body && procedure._metadata) {
		return { metadata: procedure._metadata, body: procedure._body };
	}

	// session.fs resolves relative paths against the harness cwd, set
	// by the orchestrator via ctx.init({cwd: convo.configDir}). No
	// configDir parameter or path-prepending needed.
	const raw = await session.fs.readFile(procedure.path);
	const parsed = parseFrontmatter(raw);

	const metadata: ProcedureMetadata = {
		name: procedure.name ?? parsed.frontmatter.name ?? defaultNameFromPath(procedure.path),
		triggers:
			procedure.triggers ??
			parseTriggers(parsed.frontmatter.triggers) ??
			[],
		escalateWhen: procedure.escalateWhen ?? parsed.frontmatter['escalate-when'],
	};

	procedure._metadata = metadata;
	procedure._body = parsed.body;
	return { metadata, body: parsed.body };
}

interface ParsedFrontmatter {
	frontmatter: Record<string, string>;
	body: string;
}

function parseFrontmatter(content: string): ParsedFrontmatter {
	const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
	if (!match) {
		return { frontmatter: {}, body: content.trim() };
	}
	const raw = match[1] ?? '';
	const body = (match[2] ?? '').trim();
	const fm: Record<string, string> = {};
	for (const line of raw.split('\n')) {
		const m = line.match(/^([\w-]+):\s*(.+)$/);
		if (m && m[1] && m[2]) fm[m[1]] = m[2].trim();
	}
	return { frontmatter: fm, body };
}

function parseTriggers(raw: string | undefined): string[] | undefined {
	if (!raw) return undefined;
	// Accept JSON-ish arrays: ["a", "b"] or just bare comma-separated.
	const trimmed = raw.trim();
	if (trimmed.startsWith('[')) {
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (Array.isArray(parsed)) {
				return parsed.filter((x): x is string => typeof x === 'string');
			}
		} catch {
			/* fall through to comma split */
		}
	}
	return trimmed
		.split(',')
		.map((s) => s.trim().replace(/^["']|["']$/g, ''))
		.filter(Boolean);
}

function defaultNameFromPath(path: string): string {
	const base = path.split('/').pop() ?? path;
	return base.replace(/\.(md|markdown)$/i, '');
}

/**
 * Match procedure triggers against a user message. Triggers are case-insensitive
 * substring matches; this is intentionally simple. Users who need more
 * sophisticated matching can override `triggers` in `defineProcedure` and pass
 * a regex-shaped list, but the v1 contract is plain substrings (matches Fin's
 * Procedure-trigger semantics closely).
 */
export function matchesProcedure(procedure: Procedure, userMessage: string): boolean {
	const triggers = procedure.triggers ?? procedure._metadata?.triggers ?? [];
	if (triggers.length === 0) return false;
	const lower = userMessage.toLowerCase();
	return triggers.some((t) => lower.includes(t.toLowerCase()));
}
