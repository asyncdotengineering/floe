import { describe, expect, it } from 'vitest';
import {
	contains,
	notContains,
	matches,
	enteredFlow,
	noFlowEntered,
	mentionsNode,
	costBelow,
	latencyBelow,
	defineScenario,
} from '../src/eval/index.ts';
import {
	diffAgainstBaseline,
	formatDiff,
	loadBaseline,
	saveBaseline,
} from '../src/eval/baseline.ts';
import type { AssertionContext, RunReport } from '../src/eval/index.ts';
import type { AssistantOutputEvent, AssistantState } from '../src/types.ts';
import type { TurnMetrics } from '../src/observability/types.ts';

const emptyState: AssistantState = {
	version: 1,
	assistantName: 'support',
	channelName: 'web',
	startedAt: new Date().toISOString(),
	turnCount: 1,
	activeFlow: null,
	activeProcedures: [],
	triagedAt: null,
	triageVersion: 0,
	pendingTransition: null,
	metrics: {
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalCostUsd: 0,
		lastTurnLatencyMs: 0,
		interruptionCount: 0,
	},
};

const sampleMetrics: TurnMetrics = {
	runId: 'r1',
	conversation: 'support',
	agentId: 'support',
	flowName: null,
	channelName: 'web',
	isVoice: false,
	userId: null,
	startedAtMs: 0,
	endedAtMs: 500,
	stages: {
		triageMs: 0,
		knowledgeMs: 0,
		memoryPreloadMs: 0,
		preLLMValidatorsMs: 0,
		promptBuildMs: 0,
		llmMs: 400,
		postLLMValidatorsMs: 0,
		memoryIngestMs: 0,
		totalMs: 500,
	},
	tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalCostUsd: 0.0008 },
	models: ['google/gemini-3.1-flash-lite'],
	producedReply: true,
	validatorVerdict: 'ok',
	knowledge: [],
	memoryPreloadCount: 0,
	triage: null,
};

function ctx(overrides: Partial<AssertionContext> = {}): AssertionContext {
	return {
		text: 'The Pro plan costs $12 per user per month.',
		allTexts: ['The Pro plan costs $12 per user per month.'],
		events: [],
		state: emptyState,
		metrics: [sampleMetrics],
		...overrides,
	};
}

describe('eval assertions', () => {
	it('contains() passes when text contains needle (case-insensitive)', async () => {
		const r = await contains('$12').check(ctx());
		expect(r.pass).toBe(true);
	});

	it('contains() fails clearly with the text in details', async () => {
		const r = await contains('refund').check(ctx());
		expect(r.pass).toBe(false);
		expect(r.message).toContain('refund');
	});

	it('notContains() inverts the check', async () => {
		const r1 = await notContains('refund').check(ctx());
		expect(r1.pass).toBe(true);
		const r2 = await notContains('Pro plan').check(ctx());
		expect(r2.pass).toBe(false);
	});

	it('matches() uses a regex', async () => {
		const r = await matches(/\$\d+/).check(ctx());
		expect(r.pass).toBe(true);
	});

	it('enteredFlow() detects flow_enter events', async () => {
		const events: AssistantOutputEvent[] = [
			{
				type: 'conversation_event',
				subtype: 'flow_enter',
				data: { flow: 'booking', node: 'start' },
				respondingTo: 'e1',
			},
		];
		expect((await enteredFlow('booking').check(ctx({ events }))).pass).toBe(true);
		expect((await enteredFlow('refund').check(ctx({ events }))).pass).toBe(false);
	});

	it('noFlowEntered() requires no flow_enter event', async () => {
		expect((await noFlowEntered().check(ctx({ events: [] }))).pass).toBe(true);
		expect(
			(
				await noFlowEntered().check(
					ctx({
						events: [
							{
								type: 'conversation_event',
								subtype: 'flow_enter',
								data: { flow: 'x' },
								respondingTo: 'e1',
							},
						],
					}),
				)
			).pass,
		).toBe(false);
	});

	it('mentionsNode() detects node_enter / node_exit events', async () => {
		const events: AssistantOutputEvent[] = [
			{
				type: 'conversation_event',
				subtype: 'node_enter',
				data: { node: 'collect-name' },
				respondingTo: 'e1',
			},
		];
		expect((await mentionsNode('collect-name').check(ctx({ events }))).pass).toBe(true);
		expect((await mentionsNode('other').check(ctx({ events }))).pass).toBe(false);
	});

	it('costBelow() and latencyBelow() use metrics', async () => {
		expect((await costBelow(0.01).check(ctx())).pass).toBe(true);
		expect((await costBelow(0.0001).check(ctx())).pass).toBe(false);
		expect((await latencyBelow(1000).check(ctx())).pass).toBe(true);
		expect((await latencyBelow(100).check(ctx())).pass).toBe(false);
	});

	it('defineScenario is identity', () => {
		const s = defineScenario({
			id: 's1',
			given: { sessionId: 's1' },
			when: { userMessage: 'hi' },
			expect: [contains('hello')],
		});
		expect(s.id).toBe('s1');
	});
});

describe('eval baseline diff', () => {
	function r(id: string, pass: boolean): { scenarioId: string; pass: boolean; assertions: []; finalText: string; allTexts: string[]; state: AssistantState; metrics: TurnMetrics[]; durationMs: number } {
		return {
			scenarioId: id,
			pass,
			assertions: [],
			finalText: '',
			allTexts: [],
			state: emptyState,
			metrics: [],
			durationMs: 10,
		};
	}

	it('detects regressions, improvements, new + removed scenarios', () => {
		const baseline: RunReport = {
			ranAt: '',
			totalScenarios: 3,
			passed: 2,
			failed: 1,
			results: [r('a', true), r('b', false), r('removed-1', true)],
		};
		const current: RunReport = {
			ranAt: '',
			totalScenarios: 3,
			passed: 2,
			failed: 1,
			results: [r('a', false), r('b', true), r('new-1', true)],
		};
		const diff = diffAgainstBaseline(current, baseline);
		expect(diff.regressions.map((x) => x.scenarioId)).toEqual(['a']);
		expect(diff.improvements.map((x) => x.scenarioId)).toEqual(['b']);
		expect(diff.newScenarios.map((x) => x.scenarioId)).toEqual(['new-1']);
		expect(diff.removedScenarios).toEqual(['removed-1']);
	});

	it('formatDiff produces a multi-line summary', () => {
		const baseline: RunReport = { ranAt: '', totalScenarios: 1, passed: 1, failed: 0, results: [r('a', true)] };
		const current: RunReport = { ranAt: '', totalScenarios: 1, passed: 0, failed: 1, results: [r('a', false)] };
		const out = formatDiff(diffAgainstBaseline(current, baseline));
		expect(out).toContain('REGRESSIONS');
		expect(out).toContain('- a:');
	});

	it('saveBaseline + loadBaseline round-trip via temp file', () => {
		const baseline: RunReport = {
			ranAt: 'now',
			totalScenarios: 1,
			passed: 1,
			failed: 0,
			results: [r('a', true)],
		};
		const path = `/tmp/floe-eval-baseline-${Date.now()}.json`;
		saveBaseline(baseline, path);
		const loaded = loadBaseline(path);
		expect(loaded.ranAt).toBe('now');
		expect(loaded.results).toHaveLength(1);
	});
});
