/**
 * Tests for the atomic `floePrompt({...})` helper — the single LLM-call
 * entry point Floe uses everywhere. Two layers of coverage:
 *
 *   1. End-to-end: floePrompt routes systemPrompt to the session.config
 *      slot AND dispatches user message + opts through session.prompt,
 *      in one call, with the correct ordering (slot mutation BEFORE
 *      prompt() so the slot is in place when withScopedRuntime reads it).
 *
 *   2. The internal slot applier (`_internal_applySystemPromptSlot`)
 *      throws — does NOT silently degrade — when session.config is
 *      missing. Silent degradation would route turns through Flue's
 *      HEADLESS preamble, hiding a real bug.
 */
import { describe, expect, it, vi } from 'vitest';
import {
	floePrompt,
	_internal_applySystemPromptSlot,
} from '../src/orchestrator/floe-prompt.ts';

describe('floePrompt — atomic systemPrompt + prompt dispatch', () => {
	it('mutates session.config.systemPrompt THEN calls session.prompt with raw user text', async () => {
		const callOrder: string[] = [];
		const innerConfig = { systemPrompt: 'OLD' };
		// Spy on the mutation order via a Proxy
		const cfgProxy = new Proxy(innerConfig, {
			set(target, prop, value) {
				if (prop === 'systemPrompt') callOrder.push('set-systemPrompt');
				(target as Record<string, unknown>)[prop as string] = value;
				return true;
			},
		});
		const fakeSession = {
			config: cfgProxy,
			prompt: vi.fn(async (userMessage: string, opts: unknown) => {
				callOrder.push('prompt');
				expect(innerConfig.systemPrompt).toBe('NEW');
				expect(userMessage).toBe('hi there');
				expect(opts).toMatchObject({ tools: [] });
				return { text: 'reply', usage: { input: 0, output: 0 }, model: 'm' };
			}),
		};

		const result = await floePrompt({
			session: fakeSession as unknown as never,
			systemPrompt: 'NEW',
			userMessage: 'hi there',
			options: { tools: [] },
		});

		expect((result as { text: string }).text).toBe('reply');
		expect(callOrder).toEqual(['set-systemPrompt', 'prompt']);
	});

	it('forwards options.result schema through to session.prompt for structured output', async () => {
		const fakeSession = {
			config: { systemPrompt: '' },
			prompt: vi.fn(async (_um: string, opts: { result?: unknown }) => {
				expect(opts.result).toBe('FAKE-SCHEMA');
				return { data: { reply: 'ok' }, usage: { input: 0, output: 0 }, model: 'm' };
			}),
		};
		const result = await floePrompt({
			session: fakeSession as unknown as never,
			systemPrompt: 'x',
			userMessage: 'classify this',
			options: { result: 'FAKE-SCHEMA' as unknown as never, tools: [] },
		});
		expect((result as { data: { reply: string } }).data.reply).toBe('ok');
	});

	it('propagates errors from session.prompt unchanged', async () => {
		const boom = new Error('upstream LLM blew up');
		const fakeSession = {
			config: { systemPrompt: '' },
			prompt: vi.fn(async () => {
				throw boom;
			}),
		};
		await expect(
			floePrompt({
				session: fakeSession as unknown as never,
				systemPrompt: 'x',
				userMessage: 'hi',
			}),
		).rejects.toBe(boom);
	});

	it('successive calls overwrite the slot — idempotent across turns', async () => {
		const fakeSession = {
			config: { systemPrompt: '' },
			prompt: vi.fn(async () => ({
				text: '',
				usage: { input: 0, output: 0 },
				model: 'm',
			})),
		};
		await floePrompt({
			session: fakeSession as unknown as never,
			systemPrompt: 'first',
			userMessage: 'm1',
		});
		expect(fakeSession.config.systemPrompt).toBe('first');
		await floePrompt({
			session: fakeSession as unknown as never,
			systemPrompt: 'second',
			userMessage: 'm2',
		});
		expect(fakeSession.config.systemPrompt).toBe('second');
	});

	it('accepts empty userMessage without complaint (degenerate path)', async () => {
		const fakeSession = {
			config: { systemPrompt: '' },
			prompt: vi.fn(async (um: string) => {
				expect(um).toBe('');
				return { text: '', usage: { input: 0, output: 0 }, model: 'm' };
			}),
		};
		await floePrompt({
			session: fakeSession as unknown as never,
			systemPrompt: 'whatever',
			userMessage: '',
		});
	});
});

describe('_internal_applySystemPromptSlot — strict mode', () => {
	it('throws (NOT silent degradation) when session.config is missing', () => {
		const brokenSession = {}; // no config field
		expect(() =>
			_internal_applySystemPromptSlot(brokenSession as unknown as never, 'X'),
		).toThrow(/Session\.config is not exposed/);
	});

	it('error message names the upstream fix narrative', () => {
		const brokenSession = {};
		try {
			_internal_applySystemPromptSlot(brokenSession as unknown as never, 'X');
		} catch (err) {
			expect(String(err)).toMatch(/upstream PromptOptions\.systemPrompt/i);
			expect(String(err)).toMatch(/Flue runtime version mismatch/i);
		}
	});

	it('preserves other config fields when mutating systemPrompt', () => {
		const session = {
			config: { systemPrompt: 'OLD', skills: { foo: 1 }, model: 'gpt-x' },
		};
		_internal_applySystemPromptSlot(session as unknown as never, 'NEW');
		expect(session.config.systemPrompt).toBe('NEW');
		expect((session.config as Record<string, unknown>).skills).toEqual({ foo: 1 });
		expect((session.config as Record<string, unknown>).model).toBe('gpt-x');
	});
});
