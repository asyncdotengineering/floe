/**
 * Tests for the Pi escape hatch (`AssistantConfig.pi`). Two layers:
 *
 *   1. End-to-end with the faux LLM provider — verify hooks fire,
 *      compose with Flue's own, and idempotency on multi-turn sessions.
 *
 *   2. Internal `_internal_applyPiHooks` — verify the throw-on-missing-
 *      harness contract (no silent degradation).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
	registerFloeFaux,
	fauxAssistantMessage,
	type FloeFauxHandle,
} from '../src/testing/faux.ts';
import { Assistant } from '../src/assistant.ts';
import { _internal_applyPiHooks } from '../src/orchestrator/floe-prompt.ts';

let faux: FloeFauxHandle | null = null;

afterEach(() => {
	if (faux) {
		faux.unregister();
		faux = null;
	}
});

describe('AssistantConfig.pi — orchestrator integration with faux', () => {
	// onPayload / onResponse can't be observed via the faux provider —
	// faux bypasses Pi's HTTP stack entirely (no real payload to mutate,
	// no real response to observe). Those hooks are unit-tested below
	// against the structural mutation contract (_internal_applyPiHooks).
	// These e2e tests verify the orchestrator threading: Assistant.pi
	// is reachable, doesn't throw, and the run completes normally.

	it('pi config threads through every turn without throwing', async () => {
		faux = registerFloeFaux({
			provider: 'pi-hooks-1',
			responses: [
				fauxAssistantMessage('a'),
				fauxAssistantMessage('b'),
			],
		});

		const a = new Assistant({
			name: 't', systemPrompt: 'You are a test.', mode: 'direct',
			model: 'pi-hooks-1/test', sandbox: false,
			pi: {
				onPayload: () => undefined, // pass through
				onResponse: () => {},
				sessionId: 'pinned-session-id',
				thinkingBudgets: { anthropic: 1024 },
			},
		});

		const r1 = await a.run('m1', { sessionId: 's-1' });
		const r2 = await a.run('m2', { sessionId: 's-1' });
		expect(r1.content).toContain('a');
		expect(r2.content).toContain('b');
	});

	it('no pi config → orchestrator unchanged, no overhead', async () => {
		faux = registerFloeFaux({
			provider: 'pi-hooks-2',
			responses: [fauxAssistantMessage('ok')],
		});

		const a = new Assistant({
			name: 't', systemPrompt: 's', mode: 'direct',
			model: 'pi-hooks-2/test', sandbox: false,
			// no pi field
		});

		const out = await a.run('hi', { sessionId: 's-2' });
		expect(out.content).toContain('ok');
	});

	it('pi.sessionId / thinkingBudgets set without errors and run completes', async () => {
		faux = registerFloeFaux({
			provider: 'pi-hooks-3',
			responses: [fauxAssistantMessage('ok')],
		});

		const a = new Assistant({
			name: 't', systemPrompt: 's', mode: 'direct',
			model: 'pi-hooks-3/test', sandbox: false,
			pi: {
				sessionId: 'session-from-pi-config',
				thinkingBudgets: { anthropic: 2048, google: 'medium' as never },
			},
		});

		const out = await a.run('hi', { sessionId: 's-3' });
		expect(out.content).toContain('ok');
	});
});

describe('_internal_applyPiHooks — strict mode', () => {
	it('throws when session.harness is missing (no silent degradation)', () => {
		const brokenSession = { config: { systemPrompt: '' } }; // no harness
		expect(() =>
			_internal_applyPiHooks(brokenSession as unknown as never, {
				onPayload: () => undefined,
			}),
		).toThrow(/Session\.harness is not exposed/);
	});

	it('idempotent — applying twice does not double-wrap', () => {
		const harnessOnPayload = (): unknown => 'flue-original';
		const session: Record<string | symbol, unknown> = {
			config: { systemPrompt: '' },
			harness: { onPayload: harnessOnPayload },
		};

		const userHook = () => 'user-mutated';
		_internal_applyPiHooks(session as unknown as never, { onPayload: userHook });
		const afterFirst = (session.harness as { onPayload: unknown }).onPayload;
		_internal_applyPiHooks(session as unknown as never, { onPayload: userHook });
		const afterSecond = (session.harness as { onPayload: unknown }).onPayload;

		// The function reference shouldn't change on the second call — proves
		// the apply path early-returned via the marker symbol.
		expect(afterFirst).toBe(afterSecond);
	});

	it('sets sessionId and thinkingBudgets directly on the harness', () => {
		const session: Record<string | symbol, unknown> = {
			config: { systemPrompt: '' },
			harness: {},
		};
		_internal_applyPiHooks(session as unknown as never, {
			sessionId: 'sess-abc',
			thinkingBudgets: { anthropic: 4000 },
		});
		expect((session.harness as { sessionId: string }).sessionId).toBe('sess-abc');
		expect((session.harness as { thinkingBudgets: unknown }).thinkingBudgets).toEqual({
			anthropic: 4000,
		});
	});

	it('composes onResponse additively with Flue\'s existing one', async () => {
		const flueCalls: string[] = [];
		const ourCalls: string[] = [];
		const session: Record<string | symbol, unknown> = {
			config: { systemPrompt: '' },
			harness: {
				onResponse: async () => { flueCalls.push('flue'); },
			},
		};
		_internal_applyPiHooks(session as unknown as never, {
			onResponse: async () => { ourCalls.push('ours'); },
		});
		const composed = (session.harness as { onResponse: (r: unknown, m: unknown) => Promise<void> }).onResponse;
		await composed({ status: 200, headers: {} }, {});
		expect(flueCalls).toEqual(['flue']);
		expect(ourCalls).toEqual(['ours']);
	});
});
