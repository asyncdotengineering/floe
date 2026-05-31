import { describe, expect, it, vi } from 'vitest';
import { ConsoleMetricsSink, consoleSink } from '../src/observability/console-sink.ts';
import { SentryMetricsSink } from '../src/observability/sentry-sink.ts';
import { BraintrustMetricsSink } from '../src/observability/braintrust-sink.ts';
import { OtelMetricsSink } from '../src/observability/otel-sink.ts';
import { replayEvents, transcriptFromEvents } from '../src/observability/replay.ts';
import type { TurnMetrics } from '../src/observability/types.ts';
import type { AssistantOutputEvent } from '../src/types.ts';

const sampleMetrics: TurnMetrics = {
	runId: 'run-1',
	assistantName: 'support',
	mode: 'route',
	routedTo: 'sales',
	flowName: 'booking',
	channelName: 'web',
	isVoice: false,
	userId: 'alice',
	startedAtMs: 1000,
	endedAtMs: 1500,
	stages: {
		triageMs: 100,
		knowledgeMs: 50,
		memoryPreloadMs: 25,
		preLLMValidatorsMs: 10,
		promptBuildMs: 5,
		llmMs: 200,
		postLLMValidatorsMs: 20,
		memoryIngestMs: 30,
		totalMs: 500,
	},
	tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalCostUsd: 0.001 },
	models: ['google/gemini-3.1-flash-lite'],
	producedReply: true,
	validatorVerdict: 'ok',
	knowledge: [{ source: 'help-center', chunks: 3 }],
	memoryPreloadCount: 2,
	tasks: { count: 0, totalMs: 0, errors: 0 },
	interrupted: false,
	compaction: { count: 0, totalMs: 0, messagesDropped: 0 },
};

describe('ConsoleMetricsSink', () => {
	it('writes JSON by default', () => {
		const lines: string[] = [];
		const sink = consoleSink({ write: (l) => lines.push(l) });
		sink.record(sampleMetrics);
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0]!) as TurnMetrics;
		expect(parsed.runId).toBe('run-1');
	});

	it('writes pretty when format = pretty', () => {
		const lines: string[] = [];
		const sink = new ConsoleMetricsSink({ format: 'pretty', write: (l) => lines.push(l) });
		sink.record(sampleMetrics);
		expect(lines[0]).toContain('[floe:metrics]');
		expect(lines[0]).toContain('conv=support');
		expect(lines[0]).toContain('llm=200');
	});

	it('sink name is "console"', () => {
		expect(consoleSink().name).toBe('console');
	});
});

describe('SentryMetricsSink', () => {
	it('emits breadcrumb + distribution metrics', () => {
		const addBreadcrumb = vi.fn();
		const distribution = vi.fn();
		const captureMessage = vi.fn();
		const sink = new SentryMetricsSink({
			client: { addBreadcrumb, captureMessage },
			metrics: { distribution },
		});
		sink.record(sampleMetrics);
		expect(addBreadcrumb).toHaveBeenCalledOnce();
		expect(distribution).toHaveBeenCalledWith('floe.turn.total_ms', 500, expect.any(Object));
	});

	it('calls captureMessage on escalation verdict', () => {
		const addBreadcrumb = vi.fn();
		const captureMessage = vi.fn();
		const sink = new SentryMetricsSink({ client: { addBreadcrumb, captureMessage } });
		sink.record({ ...sampleMetrics, validatorVerdict: 'escalate' });
		expect(captureMessage).toHaveBeenCalledOnce();
	});

	it('requires client', () => {
		expect(() => new SentryMetricsSink({ client: undefined as unknown as never })).toThrow(/client/);
	});
});

describe('BraintrustMetricsSink', () => {
	it('forwards metric fields + metadata to logger.log', async () => {
		const log = vi.fn().mockResolvedValue(undefined);
		const sink = new BraintrustMetricsSink({ logger: { log } });
		await sink.record(sampleMetrics);
		expect(log).toHaveBeenCalledOnce();
		const arg = log.mock.calls[0]![0] as Record<string, unknown>;
		expect((arg.metrics as Record<string, number>).total_ms).toBe(500);
		expect((arg.metadata as Record<string, unknown>).runId).toBe('run-1');
	});
});

describe('OtelMetricsSink', () => {
	it('starts a span with floe attributes and ends it', () => {
		const setAttribute = vi.fn();
		const setAttributes = vi.fn();
		const setStatus = vi.fn();
		const end = vi.fn();
		const startSpan = vi.fn().mockReturnValue({
			setAttribute,
			setAttributes,
			setStatus,
			recordException: vi.fn(),
			end,
		});
		const sink = new OtelMetricsSink({ tracer: { startSpan } });
		sink.record(sampleMetrics);
		expect(startSpan).toHaveBeenCalledOnce();
		const attrs = startSpan.mock.calls[0]![1] as { attributes?: Record<string, unknown> };
		expect(attrs.attributes?.['floe.conversation']).toBe('support');
		expect(end).toHaveBeenCalledWith(1500);
	});

	it('records histograms when meter provided', () => {
		const record = vi.fn();
		const createHistogram = vi.fn().mockReturnValue({ record });
		const sink = new OtelMetricsSink({
			tracer: {
				startSpan: () => ({
					setAttribute: vi.fn(),
					setAttributes: vi.fn(),
					setStatus: vi.fn(),
					recordException: vi.fn(),
					end: vi.fn(),
				}),
			},
			meter: { createHistogram },
		});
		sink.record(sampleMetrics);
		expect(createHistogram).toHaveBeenCalledTimes(5);
		expect(record).toHaveBeenCalledTimes(5);
	});
});

describe('replay', () => {
	const events: AssistantOutputEvent[] = [
		{ type: 'agent_send_text', text: 'Hello!', respondingTo: 'e1' },
		{
			type: 'conversation_event',
			subtype: 'flow_enter',
			data: { flow: 'booking', node: 'collect-name' },
			respondingTo: 'e1',
		},
		{ type: 'agent_send_text', text: 'Your booking is confirmed.', respondingTo: 'e2' },
	];

	it('replays events in order', async () => {
		const seen: string[] = [];
		await replayEvents(events, {
			onEvent: (e) => {
				if (e.type === 'agent_send_text') seen.push(e.text);
			},
		});
		expect(seen).toEqual(['Hello!', 'Your booking is confirmed.']);
	});

	it('transcriptFromEvents extracts assistant lines', () => {
		const t = transcriptFromEvents(events);
		expect(t).toEqual([
			{ role: 'assistant', text: 'Hello!' },
			{ role: 'assistant', text: 'Your booking is confirmed.' },
		]);
	});

	it('replay context exposes index + total', async () => {
		const seen: number[] = [];
		await replayEvents(events, {
			onEvent: (_e, ctx) => {
				seen.push(ctx.index);
				expect(ctx.total).toBe(events.length);
			},
		});
		expect(seen).toEqual([0, 1, 2]);
	});
});
