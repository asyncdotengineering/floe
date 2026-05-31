/**
 * Tests for the AGENTS.md loader. Verifies the cache-once contract, the
 * graceful missing-file behavior, and the AGENTS.md + CLAUDE.md
 * concatenation order.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	loadProjectContext,
	_resetProjectContextCache,
} from '../src/project-context.ts';

function makeDir(): string {
	return mkdtempSync(join(tmpdir(), 'floe-project-ctx-'));
}

afterEach(() => {
	_resetProjectContextCache();
});

describe('loadProjectContext', () => {
	it('returns empty string when configDir is undefined', async () => {
		expect(await loadProjectContext(undefined)).toBe('');
	});

	it('returns empty string when neither AGENTS.md nor CLAUDE.md exists', async () => {
		const dir = makeDir();
		try {
			expect(await loadProjectContext(dir)).toBe('');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('reads AGENTS.md when only it exists', async () => {
		const dir = makeDir();
		try {
			writeFileSync(join(dir, 'AGENTS.md'), '# Acme\n\nYou are warm and brief.\n');
			const ctx = await loadProjectContext(dir);
			expect(ctx).toContain('# Acme');
			expect(ctx).toContain('warm and brief');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('reads CLAUDE.md when only it exists (legacy convention)', async () => {
		const dir = makeDir();
		try {
			writeFileSync(join(dir, 'CLAUDE.md'), 'Legacy claude rules.');
			const ctx = await loadProjectContext(dir);
			expect(ctx).toBe('Legacy claude rules.');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('concatenates AGENTS.md THEN CLAUDE.md when both exist', async () => {
		const dir = makeDir();
		try {
			writeFileSync(join(dir, 'AGENTS.md'), 'AGENTS first');
			writeFileSync(join(dir, 'CLAUDE.md'), 'CLAUDE second');
			const ctx = await loadProjectContext(dir);
			expect(ctx).toBe('AGENTS first\n\nCLAUDE second');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('trims whitespace around each file', async () => {
		const dir = makeDir();
		try {
			writeFileSync(join(dir, 'AGENTS.md'), '\n\n  hello  \n\n');
			expect(await loadProjectContext(dir)).toBe('hello');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('omits empty files from the concatenation', async () => {
		const dir = makeDir();
		try {
			writeFileSync(join(dir, 'AGENTS.md'), '   \n\n  ');
			writeFileSync(join(dir, 'CLAUDE.md'), 'real content');
			expect(await loadProjectContext(dir)).toBe('real content');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('caches per configDir — second call does NOT re-read the file', async () => {
		const dir = makeDir();
		try {
			writeFileSync(join(dir, 'AGENTS.md'), 'first read');
			const a = await loadProjectContext(dir);
			// Mutate the file on disk
			writeFileSync(join(dir, 'AGENTS.md'), 'changed — should NOT be picked up');
			const b = await loadProjectContext(dir);
			expect(a).toBe('first read');
			expect(b).toBe('first read');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('cache is per-configDir — different dirs load independently', async () => {
		const a = makeDir();
		const b = makeDir();
		try {
			writeFileSync(join(a, 'AGENTS.md'), 'AAA');
			writeFileSync(join(b, 'AGENTS.md'), 'BBB');
			expect(await loadProjectContext(a)).toBe('AAA');
			expect(await loadProjectContext(b)).toBe('BBB');
		} finally {
			rmSync(a, { recursive: true, force: true });
			rmSync(b, { recursive: true, force: true });
		}
	});

	it('concurrent calls for the same configDir share one in-flight read', async () => {
		const dir = makeDir();
		try {
			writeFileSync(join(dir, 'AGENTS.md'), 'shared');
			const [a, b, c] = await Promise.all([
				loadProjectContext(dir),
				loadProjectContext(dir),
				loadProjectContext(dir),
			]);
			expect(a).toBe('shared');
			expect(b).toBe('shared');
			expect(c).toBe('shared');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
