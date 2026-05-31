/**
 * Boundary tests for `ValidatorCoordinator`. The coordinator wraps
 * `runValidatorPhase` + `fireAsyncValidators`, capturing per-turn scope.
 *
 * These tests focus on the contract: the coordinator always returns
 * a `turn` the caller MUST use, even when no rewrites happened. The
 * caller can't accidentally use the original input turn — it's
 * shadowed by the destructured return. That guarantee is the deepening
 * win; verify it holds.
 */
import { describe, expect, it } from 'vitest';
import {
	createValidatorCoordinator,
	createValidatorResultEventSink,
} from '../src/validator-coordinator.ts';
import type {
	AssistantOutputEvent,
	AssistantState,
	Validator,
} from '../src/types.ts';

function freshState(): AssistantState {
	return {
		version: 1,
		assistantName: 'test',
		channelName: 'web',
		startedAt: '',
		turnCount: 1,
		activeFlow: null,
		activeProcedures: [],
		pendingTransition: null,
		metrics: {
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalCostUsd: 0,
			lastTurnLatencyMs: 0,
			interruptionCount: 0,
		},
	};
}

const fakeSession = {} as never;

describe('createValidatorCoordinator', () => {
	it('preLLM with no validators returns ok + identical turn', async () => {
		const coord = createValidatorCoordinator({
			validators: [],
			session: fakeSession,
			state: freshState(),
			assistantName: 'a',
			flowName: null,
			channelName: 'web',
		});
		const result = await coord.preLLM({ userMessage: 'hi' });
		expect(result.verdict).toEqual({ ok: true });
		expect(result.turn.userMessage).toBe('hi');
		expect(result.failures).toEqual([]);
	});

	it('preLLM rewrite mutates returned turn (caller MUST use it)', async () => {
		const piiRedactor: Validator = {
			name: 'redact',
			phase: 'preLLM',
			validate: (turn) => ({
				rewrite: turn.userMessage?.replace(/\d/g, '*') ?? '',
			}),
		};
		const coord = createValidatorCoordinator({
			validators: [piiRedactor],
			session: fakeSession,
			state: freshState(),
			assistantName: 'a',
			flowName: null,
			channelName: 'web',
		});
		const result = await coord.preLLM({ userMessage: 'call me at 415-555-1234' });
		expect(result.verdict).toEqual({ ok: true });
		expect(result.turn.userMessage).toBe('call me at ***-***-****');
	});

	it('preLLM terminal failure stops the chain and surfaces verdict', async () => {
		const blocker: Validator = {
			name: 'block',
			phase: 'preLLM',
			validate: () => ({ escalate: { reason: 'blocked by policy' } }),
		};
		const coord = createValidatorCoordinator({
			validators: [blocker],
			session: fakeSession,
			state: freshState(),
			assistantName: 'a',
			flowName: null,
			channelName: 'web',
		});
		const result = await coord.preLLM({ userMessage: 'anything' });
		expect('ok' in result.verdict ? result.verdict.ok : false).toBe(false);
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0]!.validator).toBe('block');
	});

	it('postLLM rewrites assistantText (caller MUST use returned turn)', async () => {
		const rewriter: Validator = {
			name: 'tone',
			phase: 'postLLM',
			validate: (turn) => ({
				rewrite: (turn.assistantText ?? '') + ' [rewritten]',
			}),
		};
		const coord = createValidatorCoordinator({
			validators: [rewriter],
			session: fakeSession,
			state: freshState(),
			assistantName: 'a',
			flowName: null,
			channelName: 'web',
		});
		const result = await coord.postLLM({
			userMessage: 'm',
			assistantText: 'original reply',
		});
		expect(result.turn.assistantText).toBe('original reply [rewritten]');
	});

	it('skips validators whose phase does not match', async () => {
		const calls: string[] = [];
		const v1: Validator = {
			name: 'pre',
			phase: 'preLLM',
			validate: (turn) => { calls.push('pre'); return { ok: true }; },
		};
		const v2: Validator = {
			name: 'post',
			phase: 'postLLM',
			validate: (turn) => { calls.push('post'); return { ok: true }; },
		};
		const coord = createValidatorCoordinator({
			validators: [v1, v2],
			session: fakeSession,
			state: freshState(),
			assistantName: 'a',
			flowName: null,
			channelName: 'web',
		});
		await coord.preLLM({ userMessage: 'm' });
		expect(calls).toEqual(['pre']);
		await coord.postLLM({ userMessage: 'm', assistantText: 'a' });
		expect(calls).toEqual(['pre', 'post']);
	});

	it('respects scope.flows — skips validators for non-matching flows', async () => {
		const calls: string[] = [];
		const flowGated: Validator = {
			name: 'gated',
			phase: 'preLLM',
			scope: { flows: ['return'] },
			validate: () => { calls.push('gated'); return { ok: true }; },
		};
		const coord = createValidatorCoordinator({
			validators: [flowGated],
			session: fakeSession,
			state: freshState(),
			assistantName: 'a',
			flowName: 'track-order', // different flow
			channelName: 'web',
		});
		await coord.preLLM({ userMessage: 'm' });
		expect(calls).toEqual([]);
	});

	it('postLLMAsync fires sink for each applicable validator', async () => {
		const v: Validator = {
			name: 'async-check',
			phase: 'postLLM-async',
			validate: async () => ({ ok: true }),
		};
		const seen: Array<{ name: string; ok: boolean }> = [];
		const coord = createValidatorCoordinator({
			validators: [v],
			session: fakeSession,
			state: freshState(),
			assistantName: 'a',
			flowName: null,
			channelName: 'web',
		});
		coord.postLLMAsync(
			{ userMessage: 'm', assistantText: 'a' },
			(name, result) => seen.push({ name, ok: 'ok' in result && result.ok === true }),
		);
		// Async — give it a tick to run
		await new Promise((r) => setTimeout(r, 20));
		expect(seen).toEqual([{ name: 'async-check', ok: true }]);
	});
});

describe('createValidatorResultEventSink', () => {
	it('pushes conversation_event:validator_result events with phase + result + respondingTo', () => {
		const events: AssistantOutputEvent[] = [];
		const sink = createValidatorResultEventSink({ events, respondingTo: 'evt-1' });
		sink('safety', { ok: true });
		expect(events).toHaveLength(1);
		const e = events[0] as {
			type: string;
			subtype: string;
			data: { validator: string; phase: string; result: unknown };
			respondingTo: string;
		};
		expect(e.type).toBe('conversation_event');
		expect(e.subtype).toBe('validator_result');
		expect(e.data.validator).toBe('safety');
		expect(e.data.phase).toBe('postLLM-async');
		expect(e.data.result).toEqual({ ok: true });
		expect(e.respondingTo).toBe('evt-1');
	});
});
