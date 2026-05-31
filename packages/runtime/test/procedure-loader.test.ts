import { describe, expect, it } from 'vitest';
import { defineProcedure } from '../src/define.ts';
import { loadProcedure, matchesProcedure } from '../src/procedure-loader.ts';
import { mockSession } from './_helpers.ts';

describe('procedure-loader', () => {
	it('parses frontmatter and body, caching on the procedure object', async () => {
		const session = mockSession({
			files: {
				'procedures/refund-policy.md': `---
name: refund-policy
triggers: ["refund", "money back"]
escalate-when: angry customer
---

# Refund Policy

Body content.`,
			},
		});
		const procedure = defineProcedure('procedures/refund-policy.md');

		const first = await loadProcedure(session, procedure);
		expect(first.metadata.name).toBe('refund-policy');
		expect(first.metadata.triggers).toEqual(['refund', 'money back']);
		expect(first.metadata.escalateWhen).toBe('angry customer');
		expect(first.body).toContain('Body content.');

		// Second call returns the cached values without re-reading the file.
		const fs = (session as unknown as { fs: { files: Record<string, string> } }).fs;
		delete (fs as unknown as { files: Record<string, string> }).files?.['procedures/refund-policy.md'];
		const second = await loadProcedure(session, procedure);
		expect(second).toEqual(first);
	});

	it('falls back to filename-derived name when frontmatter has no name', async () => {
		const session = mockSession({
			files: { 'procedures/tone-policy.md': '# tone\n\nbody' },
		});
		const procedure = defineProcedure('procedures/tone-policy.md');
		const { metadata } = await loadProcedure(session, procedure);
		expect(metadata.name).toBe('tone-policy');
		expect(metadata.triggers).toEqual([]);
	});

	it('accepts triggers as comma-separated when not JSON', async () => {
		const session = mockSession({
			files: {
				'p.md': `---
name: p
triggers: refund, money back, cancel
---

body`,
			},
		});
		const procedure = defineProcedure('p.md');
		const { metadata } = await loadProcedure(session, procedure);
		expect(metadata.triggers).toEqual(['refund', 'money back', 'cancel']);
	});

	it('matchesProcedure does case-insensitive substring matching', async () => {
		const session = mockSession({
			files: {
				'p.md': `---
name: p
triggers: ["refund"]
---

body`,
			},
		});
		const procedure = defineProcedure('p.md');
		await loadProcedure(session, procedure);
		expect(matchesProcedure(procedure, 'I need a REFUND please')).toBe(true);
		expect(matchesProcedure(procedure, 'just checking my balance')).toBe(false);
	});

	it('reads procedure.path directly from session.fs (orchestrator sets the cwd via init({cwd})); no configDir param needed', async () => {
		// Workspace-rooted resolution lives in Flue's init({cwd}) wrap
		// (createCwdSessionEnv in repo/flue/packages/runtime/src/client.ts).
		// loadProcedure just reads procedure.path; session.fs handles the rest.
		const session = mockSession({
			files: {
				'procedures/refund-policy.md': `---
name: refund-policy
triggers: ["refund"]
---

# Refund`,
			},
		});
		const procedure = defineProcedure('procedures/refund-policy.md');
		const { metadata, body } = await loadProcedure(session, procedure);
		expect(metadata.name).toBe('refund-policy');
		expect(metadata.triggers).toEqual(['refund']);
		expect(body).toContain('# Refund');
	});
});
