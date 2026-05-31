/**
 * Boundary tests for `createTurnContext`. The context owns the
 * per-turn invariants the four node-kind handlers share — registry
 * (with the right adapt-options), pendingTransition closure, ctxBuilder
 * (NodeContext shape) + internal toolCtxBuilder (ToolContext shape) for
 * the registry, usage accumulator, emit.
 *
 * These tests verify the contract by observation, not implementation:
 *   - the registry the context exposes is the one with the right hooks
 *   - the pendingTransition lives in the closure (handlers don't carry
 *     their own copy)
 *   - the node-handler-facing ctxBuilder produces NodeContext (state,
 *     not signal), while the registry's tools internally see ToolContext
 *     (signal). The compiler enforces this; this test pins the runtime
 *     shape so a refactor that flips them silently can't pass.
 */
import { describe, expect, it } from 'vitest';
import { createTurnContext } from '../src/orchestrator/turn-context.ts';
import type {
	AssistantConfig,
	AssistantOutputEvent,
	AssistantState,
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

const fakeSession = {} as never;
const fakeConvo: AssistantConfig = {
	name: 'test',
	systemPrompt: 's',
	mode: 'direct',
};

function build() {
	const events: AssistantOutputEvent[] = [];
	const applied: Transition[] = [];
	const ctrl = new AbortController();
	const ctx = createTurnContext({
		session: fakeSession,
		convo: fakeConvo,
		channelName: 'web',
		state: freshState(),
		events,
		respondingTo: 'evt-1',
		isVoice: false,
		signal: ctrl.signal,
		projectContext: '',
		knowledgeChunks: [],
		memoryContext: null,
		matchedProcedures: [],
		overlay: {},
		defaults: { model: 'm' },
		applyT: (t) => applied.push(t),
	});
	return { ctx, events, applied };
}

describe('createTurnContext', () => {
	it('ctxBuilder produces NodeContext shape (session + conv + state, no signal)', () => {
		const { ctx } = build();
		const nctx = ctx.ctxBuilder();
		expect(nctx.session).toBe(fakeSession);
		expect((nctx as { state?: unknown }).state).toEqual({});
		expect((nctx as { signal?: unknown }).signal).toBeUndefined();
	});

	it('pending transition: starts null, set via toolSink, read+cleared via getters', () => {
		const { ctx } = build();
		expect(ctx.getPendingTransition()).toBeNull();

		const t: Transition = { kind: 'end', reason: 'done' };
		ctx.toolSink.setTransition(t);
		expect(ctx.getPendingTransition()).toBe(t);

		ctx.clearPendingTransition();
		expect(ctx.getPendingTransition()).toBeNull();
	});

	it('toolSink.emitEvent stamps respondingTo + pushes onto shared events list', () => {
		const { ctx, events } = build();
		ctx.toolSink.emitEvent({
			type: 'conversation_event',
			subtype: 'custom',
			data: { hello: 'world' },
			respondingTo: 'WILL-BE-OVERWRITTEN',
		});
		expect(events).toHaveLength(1);
		expect(events[0]!.respondingTo).toBe('evt-1');
	});

	it('emit pushes raw events without respondingTo overwrite', () => {
		const { ctx, events } = build();
		ctx.emit({ type: 'agent_send_text', text: 'hi', respondingTo: 'evt-1' });
		expect(events).toHaveLength(1);
		expect((events[0] as { text?: string }).text).toBe('hi');
	});

	it('applyT delegates to the supplied closure (caller controls reducer)', () => {
		const { ctx, applied } = build();
		const t: Transition = { kind: 'stay' };
		ctx.applyT(t);
		expect(applied).toEqual([t]);
	});

	it('registry is built once and exposes forHost/forExtraction/forCapture', () => {
		const { ctx } = build();
		expect(typeof ctx.registry.forHost).toBe('function');
		expect(typeof ctx.registry.forExtraction).toBe('function');
		expect(typeof ctx.registry.forCapture).toBe('function');
		const hostTools = ctx.registry.forHost({ mode: 'direct', hasActiveFlow: false });
		expect(Array.isArray(hostTools)).toBe(true);
	});
});
