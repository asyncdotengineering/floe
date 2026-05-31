/**
 * Tests for `buildSystemPrompt` — the per-turn system prompt assembler.
 * Focused on the agents.md pattern: project context lands in the prompt
 * when set, omitted entirely when empty, ordered before any per-turn
 * variation so the cache prefix stays stable.
 */
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../src/prompt-build.ts';

const BASE = {
	assistantSystemPrompt: 'You are Acme.',
	activeNode: null,
	activeProcedures: [],
	knowledgeChunks: [],
	voice: false,
	transcriptionCorrection: 'default' as const,
};

describe('buildSystemPrompt — projectContext (agents.md pattern)', () => {
	it('includes the # Project context block when projectContext is set', () => {
		const out = buildSystemPrompt({
			...BASE,
			projectContext: 'You are warm. Currency is USD.',
		});
		expect(out).toContain('# Project context');
		expect(out).toContain('You are warm.');
		expect(out).toContain('Currency is USD.');
	});

	it('omits the block when projectContext is undefined', () => {
		const out = buildSystemPrompt({ ...BASE });
		expect(out).not.toContain('# Project context');
	});

	it('omits the block when projectContext is empty string', () => {
		const out = buildSystemPrompt({ ...BASE, projectContext: '' });
		expect(out).not.toContain('# Project context');
	});

	it('places project context AFTER assistantSystemPrompt (stable cache prefix)', () => {
		const out = buildSystemPrompt({
			...BASE,
			assistantSystemPrompt: 'You are Acme.',
			projectContext: 'Currency is USD.',
		});
		const ap = out.indexOf('You are Acme.');
		const pc = out.indexOf('# Project context');
		expect(ap).toBeGreaterThan(-1);
		expect(pc).toBeGreaterThan(ap);
	});

	it('places project context BEFORE per-turn knowledge chunks (cacheable prefix)', () => {
		const out = buildSystemPrompt({
			...BASE,
			projectContext: 'Hard rules',
			knowledgeChunks: [
				{ text: 'Echo Pima T-shirt …', source: 'product-catalog', score: 0.9 },
			],
		});
		const pc = out.indexOf('# Project context');
		const km = out.indexOf('# Reference material');
		expect(pc).toBeGreaterThan(-1);
		expect(km).toBeGreaterThan(pc);
	});

	it('survives multi-line markdown bodies without escaping', () => {
		const ctx = `# Tone

Warm, brief, decisive. **No filler.**

## Hard rules

- USD with \`$\` prefix
- IDs look like \`ord_NNNN\``;
		const out = buildSystemPrompt({ ...BASE, projectContext: ctx });
		expect(out).toContain('Warm, brief, decisive.');
		expect(out).toContain('- USD with `$` prefix');
	});
});

describe('buildSystemPrompt — citations policy', () => {
	const WITH_CHUNK = {
		...BASE,
		knowledgeChunks: [
			{ source: 'help-center', score: 0.9, text: 'Standard shipping is $7.' },
		],
	};

	it("default ('off') forbids bracketed citations", () => {
		const out = buildSystemPrompt(WITH_CHUNK);
		expect(out).toContain('Do NOT add bracketed citations');
		expect(out).not.toContain('CITE by bracketed number');
		expect(out).not.toContain('MAY cite');
	});

	it("'optional' uses MAY-cite wording + don't-cite-tools rule", () => {
		const out = buildSystemPrompt({ ...WITH_CHUNK, citations: 'optional' });
		expect(out).toContain('You MAY cite by bracketed number');
		expect(out).toContain('do NOT bracket-cite');
	});

	it("'required' uses CITE-by-number imperative + don't-cite-tools rule", () => {
		const out = buildSystemPrompt({ ...WITH_CHUNK, citations: 'required' });
		expect(out).toContain('CITE by bracketed number when you use a reference');
		expect(out).toContain('do NOT bracket-cite');
	});

	it("explicit 'off' produces same output as default", () => {
		const a = buildSystemPrompt(WITH_CHUNK);
		const b = buildSystemPrompt({ ...WITH_CHUNK, citations: 'off' });
		expect(a).toEqual(b);
	});

	it('voice channel forces "off" regardless of citations setting', () => {
		const out = buildSystemPrompt({
			...WITH_CHUNK,
			voice: true,
			citations: 'required',
		});
		expect(out).toContain('Do NOT add bracketed citations');
		expect(out).not.toContain('CITE by bracketed number');
	});

	it('no knowledge chunks → no citation guidance at all', () => {
		const out = buildSystemPrompt({ ...BASE, citations: 'required' });
		expect(out).not.toContain('CITE');
		expect(out).not.toContain('bracketed citations');
	});
});
