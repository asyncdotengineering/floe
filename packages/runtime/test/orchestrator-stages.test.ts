/**
 * Per-stage unit tests for the orchestrator extraction (C-7).
 *
 * Tests the pure-function boundaries of each stage. Integration
 * tests that require LLM calls stay in runtime/test/*.
 */
import { describe, expect, it } from 'vitest';
import { prepareTurn, type PrepareTurnResult } from '../src/orchestrator/prepare-turn.ts';
import { retrieve } from '../src/orchestrator/retrieve.ts';
import { respond } from '../src/orchestrator/respond.ts';
import { finalizeTurn } from '../src/orchestrator/finalize-turn.ts';
import type { PrepareTurnOutput, RetrieveOutput, RespondOutput, FinalizeTurnContext } from '../src/orchestrator/types.ts';
import type { AssistantState, AssistantConfig, FloeConfig } from '../src/types.ts';
import { InMemoryAssistantStateStore } from '../src/assistant-state-store.ts';
import { createMemoryCoordinator } from '../src/memory/coordinator.ts';

const mockChannel = {
	name: 'web',
	kind: 'http' as const,
	async parseInbound() {
		return {
			type: 'user_text_sent' as const,
			content: 'hello',
			eventId: 'evt-1',
		};
	},
};
const mockConvo: AssistantConfig = {
	name: 'test',
	systemPrompt: 'You greet.',
	mode: 'direct',
};
const mockDefaults: FloeConfig['defaults'] = {
	model: 'test-model',
};

const mockCtx = {
	id: 'sess-1',
	runId: 'run-1',
	init: async () => ({
		session: async () => ({
			prompt: async () => ({ text: 'hello', usage: undefined }),
			name: 'test-session',
			// `config.systemPrompt` mirrors Flue's Session.config — required
			// for `floePrompt` (the atomic LLM-call helper) to land its
			// systemPrompt in the real system message slot. Strict throw on
			// missing config is intentional (no silent degradation).
			config: { systemPrompt: '' },
		}),
	}),
};

describe('prepare-turn stage', () => {
	it('returns continue with populated output for a normal turn', async () => {
		const result = await prepareTurn({
			ctx: mockCtx as never,
			convo: mockConvo,
			channel: mockChannel,
			defaults: mockDefaults,
		});
		expect(result.kind).toBe('continue');
		const out = (result as { kind: 'continue'; output: PrepareTurnOutput }).output;
		expect(out.mode).toBe('direct');
		expect(out.routedTo).toBeUndefined();
		expect(out.state.turnCount).toBe(1);
	});

	it('returns early exit when rate limiter blocks', async () => {
		const defaultsWithRL: FloeConfig['defaults'] = {
			...mockDefaults,
			rateLimit: {
				name: 'test-limiter',
				check: () => ({ allow: false, reason: 'quota' }),
			},
		};
		const result = await prepareTurn({
			ctx: mockCtx as never,
			convo: mockConvo,
			channel: mockChannel,
			defaults: defaultsWithRL,
		});
		expect(result.kind).toBe('exit');
		const out = (result as { kind: 'exit'; result: { text: string } }).result;
		expect(out.text).toBe('quota');
	});

	it('mode=route falls back to first role when selection fails', async () => {
		// With mode='route' and no roles defined, runRouteSelection throws
		// inside but is caught — the orchestrator just runs as if direct.
		const routeConvo: AssistantConfig = {
			...mockConvo,
			mode: 'route',
		};
		const result = await prepareTurn({
			ctx: mockCtx as never,
			convo: routeConvo,
			channel: mockChannel,
			defaults: mockDefaults,
		});
		expect(result.kind).toBe('continue');
	});
});

describe('retrieve stage', () => {
	it('returns empty retrieval for conversation without knowledge or memory', async () => {
		const result = await retrieve({
			session: { fs: { readFile: async () => 'body' } } as never,
			convo: mockConvo,
			userMessage: 'hello',
			events: [],
			respondingTo: 'evt-1',
			memory: createMemoryCoordinator(null),
			userId: undefined,
			stages: {
				triageMs: 0, knowledgeMs: 0, memoryPreloadMs: 0,
				preLLMValidatorsMs: 0, promptBuildMs: 0, llmMs: 0,
				postLLMValidatorsMs: 0, memoryIngestMs: 0, totalMs: 0,
			},
		});
		expect(result.matchedProcedures).toEqual([]);
		expect(result.knowledgeChunks).toEqual([]);
		expect(result.memoryContext).toBeNull();
		expect(result.memoryPreloadCount).toBe(0);
		expect(result.stages.knowledgeMs).toBeGreaterThanOrEqual(0);
	});

	it('records knowledge stage timing', async () => {
		const result = await retrieve({
			session: { fs: { readFile: async () => 'body' } } as never,
			convo: mockConvo,
			userMessage: 'hello',
			events: [],
			respondingTo: 'evt-1',
			memory: createMemoryCoordinator(null),
			userId: undefined,
			stages: {
				triageMs: 10, knowledgeMs: 0, memoryPreloadMs: 0,
				preLLMValidatorsMs: 0, promptBuildMs: 0, llmMs: 0,
				postLLMValidatorsMs: 0, memoryIngestMs: 0, totalMs: 0,
			},
		});
		expect(result.stages.knowledgeMs).toBeGreaterThanOrEqual(0);
		expect(result.stages.memoryPreloadMs).toBeGreaterThanOrEqual(0);
	});
});

describe('respond stage', () => {
	it('returns failure when preLLM validator blocks', async () => {
		const validatorConvo: AssistantConfig = {
			...mockConvo,
			validators: [{
				name: 'blocker',
				phase: 'preLLM',
				validate: () => ({ escalate: { reason: 'nope' } }),
			}],
		};
		const result = await respond({
			session: { prompt: async () => ({ text: 'hi' }), config: { systemPrompt: '' } } as never,
			convo: validatorConvo,
			channel: { name: 'web' },
			state: { version: 1, assistantName: 'test', channelName: 'web', startedAt: '', turnCount: 1, activeFlow: null, activeProcedures: [], pendingTransition: null, metrics: { totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, lastTurnLatencyMs: 0, interruptionCount: 0 } } as AssistantState,
			events: [],
			userMessage: 'hi',
			respondingTo: 'evt-1',
			mode: 'direct', routedTo: undefined, harness: { session: async () => ({ name: "stub-child" }) } as never, signal: new AbortController().signal,
			isVoice: false,
			stages: {
				triageMs: 0, knowledgeMs: 0, memoryPreloadMs: 0,
				preLLMValidatorsMs: 0, promptBuildMs: 0, llmMs: 0,
				postLLMValidatorsMs: 0, memoryIngestMs: 0, totalMs: 0,
			},
			knowledgeChunks: [],
			memoryContext: null,
			matchedProcedures: [],
			defaultsModel: 'test-model',
			defaults: mockDefaults,
			overlay: {},
			assistantStateStore: new InMemoryAssistantStateStore(),
			sessionId: 'sess-1',
			turnStart: Date.now(),
			instanceId: 'inst-1',
		});
		expect(result.kind).toBe('failure');
	});

	it('returns success with assistantText when LLM produces text', async () => {
		const result = await respond({
			session: { prompt: async () => ({ text: 'Hello! How can I help?' }), config: { systemPrompt: '' } } as never,
			convo: mockConvo,
			channel: { name: 'web' },
			state: { version: 1, assistantName: 'test', channelName: 'web', startedAt: '', turnCount: 1, activeFlow: null, activeProcedures: [], pendingTransition: null, metrics: { totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, lastTurnLatencyMs: 0, interruptionCount: 0 } } as AssistantState,
			events: [],
			userMessage: 'hi',
			respondingTo: 'evt-1',
			mode: 'direct', routedTo: undefined, harness: { session: async () => ({ name: "stub-child" }) } as never, signal: new AbortController().signal,
			isVoice: false,
			stages: {
				triageMs: 0, knowledgeMs: 0, memoryPreloadMs: 0,
				preLLMValidatorsMs: 0, promptBuildMs: 0, llmMs: 0,
				postLLMValidatorsMs: 0, memoryIngestMs: 0, totalMs: 0,
			},
			knowledgeChunks: [],
			memoryContext: null,
			matchedProcedures: [],
			defaultsModel: 'test-model',
			defaults: mockDefaults,
			overlay: {},
			assistantStateStore: new InMemoryAssistantStateStore(),
			sessionId: 'sess-1',
			turnStart: Date.now(),
			instanceId: 'inst-1',
		});
		expect(result.kind).toBe('success');
		const out = (result as { kind: 'success'; output: RespondOutput }).output;
		expect(out.assistantText).toBe('Hello! How can I help?');
		expect(out.modelsUsed).toContain('test-model');
	});

	it('records preLLM and postLLM validator timing', async () => {
		const result = await respond({
			session: { prompt: async () => ({ text: 'ok' }), config: { systemPrompt: '' } } as never,
			convo: mockConvo,
			channel: { name: 'web' },
			state: { version: 1, assistantName: 'test', channelName: 'web', startedAt: '', turnCount: 1, activeFlow: null, activeProcedures: [], pendingTransition: null, metrics: { totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, lastTurnLatencyMs: 0, interruptionCount: 0 } } as AssistantState,
			events: [],
			userMessage: 'hi',
			respondingTo: 'evt-1',
			mode: 'direct', routedTo: undefined, harness: { session: async () => ({ name: "stub-child" }) } as never, signal: new AbortController().signal,
			isVoice: false,
			stages: {
				triageMs: 0, knowledgeMs: 0, memoryPreloadMs: 0,
				preLLMValidatorsMs: 0, promptBuildMs: 0, llmMs: 0,
				postLLMValidatorsMs: 0, memoryIngestMs: 0, totalMs: 0,
			},
			knowledgeChunks: [],
			memoryContext: null,
			matchedProcedures: [],
			defaultsModel: 'test-model',
			defaults: mockDefaults,
			overlay: {},
			assistantStateStore: new InMemoryAssistantStateStore(),
			sessionId: 'sess-1',
			turnStart: Date.now(),
			instanceId: 'inst-1',
		});
		expect(result.kind).toBe('success');
		const out = (result as { kind: 'success'; output: RespondOutput }).output;
		expect(out.stages.preLLMValidatorsMs).toBeGreaterThanOrEqual(0);
		expect(out.stages.postLLMValidatorsMs).toBeGreaterThanOrEqual(0);
		expect(out.stages.llmMs).toBeGreaterThanOrEqual(0);
		expect(out.stages.promptBuildMs).toBeGreaterThanOrEqual(0);
	});
});

describe('finalize-turn stage', () => {
	it('persists state and emits metrics', async () => {
		const store = new InMemoryAssistantStateStore();
		const state: AssistantState = {
			version: 1, assistantName: 'test',
			channelName: 'web', startedAt: '', turnCount: 1,
			activeFlow: null, activeProcedures: [], triagedAt: null,
			triageVersion: 0, pendingTransition: null,
			metrics: { totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, lastTurnLatencyMs: 0, interruptionCount: 0 },
		};
		const ctx = {
			session: { name: 'test-session' },
			convo: { name: "test", systemPrompt: "You greet." },
			state,
			events: [],
			userMessage: 'hi',
			respondingTo: 'evt-1',
			mode: 'direct', routedTo: undefined, harness: { session: async () => ({ name: "stub-child" }) } as never, signal: new AbortController().signal,
			mode: "direct" as const, routedTo: undefined,
			isVoice: false,
			userId: undefined,
			stages: {
				triageMs: 10, knowledgeMs: 5, memoryPreloadMs: 3,
				preLLMValidatorsMs: 1, promptBuildMs: 2, llmMs: 100,
				postLLMValidatorsMs: 1, memoryIngestMs: 0, totalMs: 0,
			},
			turnStart: 1000,
			memory: createMemoryCoordinator(null),
			assistantText: 'Hello!',
			lastFinalizedTransition: null,
			totalUsageInput: 10,
			totalUsageOutput: 5,
			totalUsageCacheRead: 0,
			totalUsageCacheWrite: 0,
			totalUsageCost: 0.001,
			modelsUsed: ['test-model'],
			validatorVerdict: 'ok' as const,
			knowledgeUsage: [],
			memoryPreloadCount: 0,
			assistantStateStore: store,
			transcriptStore: undefined,
			observability: undefined,
			sessionId: 'sess-1',
			ctxRunId: 'run-1',
			defaultsModel: 'test-model',
			defaults: mockDefaults,
			view: {} as never,
		} as FinalizeTurnContext;

		const result = await finalizeTurn(ctx);
		expect(result.text).toBe('Hello!');
		expect(result.state.metrics.lastTurnLatencyMs).toBeGreaterThan(0);

		// Verify state was persisted
		const saved = await store.load('sess-1');
		expect(saved).not.toBeNull();
		expect(saved!.metrics.lastTurnLatencyMs).toBeGreaterThan(0);
	});

	it('handles transcript append', async () => {
		const store = new InMemoryAssistantStateStore();
		const transcripts: { id: string; role: string }[] = [];
		const transcriptStore = {
			async append(_sid: string, msg: { id: string; role: string }) {
				transcripts.push(msg);
			},
		};

		const state: AssistantState = {
			version: 1, assistantName: 'test',
			channelName: 'web', startedAt: '', turnCount: 1,
			activeFlow: null, activeProcedures: [], triagedAt: null,
			triageVersion: 0, pendingTransition: null,
			metrics: { totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, lastTurnLatencyMs: 0, interruptionCount: 0 },
		};
		const ctx = {
			session: { name: 'test-session' },
			convo: { name: "test", systemPrompt: "You greet." },
			state,
			events: [],
			userMessage: 'hi',
			respondingTo: 'evt-1',
			mode: 'direct', routedTo: undefined, harness: { session: async () => ({ name: "stub-child" }) } as never, signal: new AbortController().signal,
			mode: "direct" as const, routedTo: undefined,
			isVoice: false,
			userId: 'alice',
			stages: {
				triageMs: 10, knowledgeMs: 5, memoryPreloadMs: 3,
				preLLMValidatorsMs: 1, promptBuildMs: 2, llmMs: 100,
				postLLMValidatorsMs: 1, memoryIngestMs: 0, totalMs: 0,
			},
			turnStart: 1000,
			memory: createMemoryCoordinator(null),
			assistantText: 'Hello!',
			lastFinalizedTransition: null,
			totalUsageInput: 10,
			totalUsageOutput: 5,
			totalUsageCacheRead: 0,
			totalUsageCacheWrite: 0,
			totalUsageCost: 0.001,
			modelsUsed: ['test-model'],
			validatorVerdict: 'ok' as const,
			knowledgeUsage: [],
			memoryPreloadCount: 0,
			assistantStateStore: store,
			transcriptStore: transcriptStore as FinalizeTurnContext['transcriptStore'],
			observability: undefined,
			sessionId: 'sess-1',
			ctxRunId: 'run-1',
			defaultsModel: 'test-model',
			defaults: mockDefaults,
			view: {} as never,
		} as FinalizeTurnContext;

		await finalizeTurn(ctx);
		expect(transcripts).toHaveLength(2);
		expect(transcripts[0]!.role).toBe('user');
		expect(transcripts[1]!.role).toBe('assistant');
	});
});
