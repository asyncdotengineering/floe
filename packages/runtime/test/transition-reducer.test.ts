/**
 * Pure-function tests for `reduceTransition`. The reducer is the new
 * source of truth for "what does a transition do?" — these tests
 * replace the implicit coverage that used to live across orchestrator
 * integration tests.
 *
 * No session, no harness, no config beyond `{roles}`. Just data in,
 * data out.
 */
import { describe, expect, it } from 'vitest';
import { reduceTransition } from '../src/orchestrator/transition-reducer.ts';
import type {
	AssistantState,
	Flow,
	Node,
	ReplyNode,
	Transition,
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

function fakeReplyNode(name: string): ReplyNode {
	return {
		kind: 'reply',
		name,
		prompt: 'p',
		next: { kind: 'end', reason: 'done' },
	};
}

function fakeFlow(name: string, startNode: Node): Flow {
	return {
		name,
		description: 'desc',
		startNode: () => startNode,
	};
}

describe('reduceTransition', () => {
	describe('flow_enter', () => {
		it('opens an activeFlow with the start node, args, and timestamp; clears pendingTransition', () => {
			const state = freshState();
			const start = fakeReplyNode('start');
			const flow = fakeFlow('return', start);
			const t: Transition = { kind: 'flow_enter', flow, args: { orderId: 'ord_1' } };
			const eff = reduceTransition(t, state, {}, 'evt-1');
			eff.stateMutation(state);
			expect(state.activeFlow).not.toBeNull();
			expect(state.activeFlow!.name).toBe('return');
			expect(state.activeFlow!.nodeName).toBe('start');
			expect(state.activeFlow!.data).toEqual({ orderId: 'ord_1' });
			expect(state.activeFlow!.enteredAt).toMatch(/^\d{4}-/); // ISO date
			expect(state.pendingTransition).toBeNull();
		});

		it('emits a conversation_event flow_enter with the flow + node names + args', () => {
			const state = freshState();
			const start = fakeReplyNode('start');
			const flow = fakeFlow('return', start);
			const t: Transition = { kind: 'flow_enter', flow, args: { orderId: 'ord_1' } };
			const eff = reduceTransition(t, state, {}, 'evt-1');
			expect(eff.events).toHaveLength(1);
			const e = eff.events[0] as {
				type: string;
				subtype: string;
				data: { flow: string; node: string; args: Record<string, unknown> };
				respondingTo: string;
			};
			expect(e.type).toBe('conversation_event');
			expect(e.subtype).toBe('flow_enter');
			expect(e.data).toEqual({ flow: 'return', node: 'start', args: { orderId: 'ord_1' } });
			expect(e.respondingTo).toBe('evt-1');
		});

		it('defaults args to {} when not provided', () => {
			const state = freshState();
			const start = fakeReplyNode('start');
			const flow = fakeFlow('return', start);
			const t: Transition = { kind: 'flow_enter', flow };
			const eff = reduceTransition(t, state, {}, 'evt');
			eff.stateMutation(state);
			expect(state.activeFlow!.data).toEqual({});
		});

		it('requests caching of the start node for the active flow', () => {
			const state = freshState();
			const start = fakeReplyNode('start');
			const flow = fakeFlow('return', start);
			const t: Transition = { kind: 'flow_enter', flow };
			const eff = reduceTransition(t, state, {}, 'evt');
			expect(eff.cacheNode).toEqual({ flowName: 'return', node: start });
		});
	});

	describe('node', () => {
		it('updates activeFlow.nodeName + emits node_enter with from/to', () => {
			const state = freshState();
			state.activeFlow = {
				name: 'return',
				nodeName: 'collect',
				data: {},
				enteredAt: '',
			};
			const next = fakeReplyNode('lookup');
			const t: Transition = { kind: 'node', node: next };
			const eff = reduceTransition(t, state, {}, 'evt');
			eff.stateMutation(state);
			expect(state.activeFlow!.nodeName).toBe('lookup');
			const e = eff.events[0] as { data: { from: string | null; to: string } };
			expect(e.data).toEqual({ from: 'collect', to: 'lookup' });
		});

		it('emits node_enter with from=null when activeFlow is null', () => {
			const state = freshState();
			const next = fakeReplyNode('orphan');
			const t: Transition = { kind: 'node', node: next };
			const eff = reduceTransition(t, state, {}, 'evt');
			const e = eff.events[0] as { data: { from: string | null } };
			expect(e.data.from).toBeNull();
		});

		it('does NOT request caching when activeFlow is null (orphan node transition)', () => {
			const state = freshState();
			const t: Transition = { kind: 'node', node: fakeReplyNode('orphan') };
			const eff = reduceTransition(t, state, {}, 'evt');
			expect(eff.cacheNode).toBeUndefined();
		});

		it('requests caching for the active flow when one is set', () => {
			const state = freshState();
			state.activeFlow = { name: 'return', nodeName: 'collect', data: {}, enteredAt: '' };
			const next = fakeReplyNode('lookup');
			const eff = reduceTransition({ kind: 'node', node: next }, state, {}, 'evt');
			expect(eff.cacheNode).toEqual({ flowName: 'return', node: next });
		});
	});

	describe('handoff', () => {
		it('clears activeFlow + emits flow_exit when role is valid', () => {
			const state = freshState();
			state.activeFlow = { name: 'x', nodeName: 'y', data: {}, enteredAt: '' };
			const t: Transition = { kind: 'handoff', role: 'specialist', reason: 'transfer' };
			const eff = reduceTransition(t, state, { roles: { specialist: {} as never } }, 'evt');
			eff.stateMutation(state);
			expect(state.activeFlow).toBeNull();
			expect(eff.events[0]).toMatchObject({
				type: 'conversation_event',
				subtype: 'flow_exit',
				data: { handoffTo: 'specialist', reason: 'transfer' },
			});
			expect(eff.error).toBeUndefined();
		});

		it('returns error + no mutation/events when role is unknown', () => {
			const state = freshState();
			state.activeFlow = { name: 'x', nodeName: 'y', data: {}, enteredAt: '' };
			const t: Transition = { kind: 'handoff', role: 'no-such', reason: 'r' };
			const eff = reduceTransition(t, state, { roles: { specialist: {} as never } }, 'evt');
			expect(eff.error).toContain('no-such');
			expect(eff.events).toEqual([]);
			eff.stateMutation(state); // should be no-op
			expect(state.activeFlow).not.toBeNull(); // unchanged
		});

		it('does NOT validate when convo.roles is undefined (legacy permissive path)', () => {
			const state = freshState();
			const t: Transition = { kind: 'handoff', role: 'anything', reason: 'r' };
			const eff = reduceTransition(t, state, {}, 'evt');
			expect(eff.error).toBeUndefined();
			expect(eff.events).toHaveLength(1);
		});
	});

	describe('end', () => {
		it('clears activeFlow + emits agent_end with reason', () => {
			const state = freshState();
			state.activeFlow = { name: 'x', nodeName: 'y', data: {}, enteredAt: '' };
			state.pendingTransition = { kind: 'stay' };
			const t: Transition = { kind: 'end', reason: 'done' };
			const eff = reduceTransition(t, state, {}, 'evt');
			eff.stateMutation(state);
			expect(state.activeFlow).toBeNull();
			expect(state.pendingTransition).toBeNull();
			expect(eff.events[0]).toMatchObject({ type: 'agent_end', reason: 'done' });
		});
	});

	describe('escalate', () => {
		it('clears activeFlow + emits agent_escalate with to + reason', () => {
			const state = freshState();
			state.activeFlow = { name: 'x', nodeName: 'y', data: {}, enteredAt: '' };
			const t: Transition = { kind: 'escalate', to: 'human', reason: 'complex' };
			const eff = reduceTransition(t, state, {}, 'evt');
			eff.stateMutation(state);
			expect(state.activeFlow).toBeNull();
			expect(eff.events[0]).toMatchObject({
				type: 'agent_escalate',
				to: 'human',
				reason: 'complex',
			});
		});
	});

	describe('stay', () => {
		it('emits nothing, clears pendingTransition, does not touch activeFlow', () => {
			const state = freshState();
			state.activeFlow = { name: 'x', nodeName: 'y', data: { a: 1 }, enteredAt: '' };
			state.pendingTransition = { kind: 'stay' };
			const eff = reduceTransition({ kind: 'stay' }, state, {}, 'evt');
			eff.stateMutation(state);
			expect(state.pendingTransition).toBeNull();
			expect(state.activeFlow).toEqual({ name: 'x', nodeName: 'y', data: { a: 1 }, enteredAt: '' });
			expect(eff.events).toEqual([]);
		});
	});

	describe('extraction_submission (defensive no-op)', () => {
		it('emits nothing and clears pendingTransition', () => {
			const state = freshState();
			state.pendingTransition = {
				kind: 'extraction_submission',
				args: { orderId: 'x' },
				node: 'collect-order',
			};
			const eff = reduceTransition(
				{ kind: 'extraction_submission', args: { orderId: 'x' }, node: 'collect-order' },
				state, {}, 'evt',
			);
			eff.stateMutation(state);
			expect(state.pendingTransition).toBeNull();
			expect(eff.events).toEqual([]);
		});
	});

	describe('purity', () => {
		it('does not mutate input state', () => {
			const state = freshState();
			state.activeFlow = { name: 'x', nodeName: 'y', data: { a: 1 }, enteredAt: '' };
			const stateSnapshot = JSON.stringify(state);
			reduceTransition({ kind: 'end', reason: 'done' }, state, {}, 'evt');
			// Did NOT apply stateMutation — state should be untouched
			expect(JSON.stringify(state)).toBe(stateSnapshot);
		});

		it('same input → same output (deterministic, modulo enteredAt timestamp)', () => {
			const state = freshState();
			const start = fakeReplyNode('s');
			const flow = fakeFlow('f', start);
			const t: Transition = { kind: 'flow_enter', flow, args: { x: 1 } };
			const e1 = reduceTransition(t, state, {}, 'evt');
			const e2 = reduceTransition(t, state, {}, 'evt');
			expect(e1.events).toEqual(e2.events);
			expect(e1.cacheNode).toEqual(e2.cacheNode);
			expect(e1.error).toBe(e2.error);
		});
	});
});
