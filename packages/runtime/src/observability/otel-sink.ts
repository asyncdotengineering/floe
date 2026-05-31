/**
 * OpenTelemetry MetricsSink. Emits a span per turn plus counter/histogram
 * metrics. Structurally typed against `@opentelemetry/api`'s Tracer +
 * Meter shapes so no hard dep is added to `@floe/runtime`.
 *
 * Pass in a `tracer` from your provider:
 *   import { trace } from '@opentelemetry/api';
 *   const tracer = trace.getTracer('floe', '0.1.0');
 *   otelSink({ tracer, meter });
 */
import type { MetricsSink, TurnMetrics } from './types.ts';

interface SpanLike {
	setAttribute(key: string, value: unknown): void;
	setAttributes(attrs: Record<string, unknown>): void;
	setStatus(status: { code: number; message?: string }): void;
	recordException(exception: unknown): void;
	end(endTime?: number): void;
}

interface TracerLike {
	startSpan(
		name: string,
		options?: { startTime?: number; attributes?: Record<string, unknown> },
	): SpanLike;
}

interface HistogramLike {
	record(value: number, attributes?: Record<string, unknown>): void;
}

interface MeterLike {
	createHistogram(name: string, options?: { description?: string; unit?: string }): HistogramLike;
	createCounter?(name: string, options?: { description?: string }): { add(value: number, attributes?: Record<string, unknown>): void };
}

export interface OtelSinkOptions {
	tracer: TracerLike;
	meter?: MeterLike;
}

const STATUS_OK = 1;
const STATUS_ERROR = 2;

export class OtelMetricsSink implements MetricsSink {
	readonly name = 'otel';
	private readonly tracer: TracerLike;
	private readonly histograms: {
		total: HistogramLike;
		llm: HistogramLike;
		tokensIn: HistogramLike;
		tokensOut: HistogramLike;
		cost: HistogramLike;
	} | null;

	constructor(opts: OtelSinkOptions) {
		if (!opts.tracer) throw new Error('[OtelMetricsSink] tracer is required');
		this.tracer = opts.tracer;
		this.histograms = opts.meter
			? {
					total: opts.meter.createHistogram('floe.turn.total_ms', { unit: 'ms', description: 'Total per-turn latency' }),
					llm: opts.meter.createHistogram('floe.turn.llm_ms', { unit: 'ms', description: 'LLM call latency' }),
					tokensIn: opts.meter.createHistogram('floe.turn.tokens_in', { description: 'Input tokens per turn' }),
					tokensOut: opts.meter.createHistogram('floe.turn.tokens_out', { description: 'Output tokens per turn' }),
					cost: opts.meter.createHistogram('floe.turn.cost_usd', { description: 'USD cost per turn' }),
				}
			: null;
	}

	record(metrics: TurnMetrics): void {
		const span = this.tracer.startSpan(`floe.turn ${metrics.assistantName}`, {
			startTime: metrics.startedAtMs,
			attributes: {
				'floe.conversation': metrics.assistantName,
				'floe.agent_id': metrics.routedTo ?? '',
				'floe.flow_name': metrics.flowName ?? '',
				'floe.channel': metrics.channelName,
				'floe.is_voice': metrics.isVoice,
				'floe.user_id': metrics.userId ?? '',
				'floe.verdict': metrics.validatorVerdict,
				'floe.produced_reply': metrics.producedReply,
				'floe.models': metrics.models.join(','),
			},
		});
		span.setAttribute('floe.stages.triage_ms', metrics.stages.triageMs);
		span.setAttribute('floe.stages.knowledge_ms', metrics.stages.knowledgeMs);
		span.setAttribute('floe.stages.memory_preload_ms', metrics.stages.memoryPreloadMs);
		span.setAttribute('floe.stages.pre_llm_validators_ms', metrics.stages.preLLMValidatorsMs);
		span.setAttribute('floe.stages.prompt_build_ms', metrics.stages.promptBuildMs);
		span.setAttribute('floe.stages.llm_ms', metrics.stages.llmMs);
		span.setAttribute('floe.stages.post_llm_validators_ms', metrics.stages.postLLMValidatorsMs);
		span.setAttribute('floe.stages.memory_ingest_ms', metrics.stages.memoryIngestMs);
		span.setAttribute('floe.tokens.input', metrics.tokens.input);
		span.setAttribute('floe.tokens.output', metrics.tokens.output);
		span.setAttribute('floe.tokens.cost_usd', metrics.tokens.totalCostUsd);
		span.setStatus({ code: metrics.validatorVerdict === 'ok' ? STATUS_OK : STATUS_ERROR });
		span.end(metrics.endedAtMs);

		if (this.histograms) {
			const attrs = {
				'floe.conversation': metrics.assistantName,
				'floe.channel': metrics.channelName,
				'floe.agent_id': metrics.routedTo ?? '',
			};
			this.histograms.total.record(metrics.stages.totalMs, attrs);
			this.histograms.llm.record(metrics.stages.llmMs, attrs);
			this.histograms.tokensIn.record(metrics.tokens.input, attrs);
			this.histograms.tokensOut.record(metrics.tokens.output, attrs);
			this.histograms.cost.record(metrics.tokens.totalCostUsd, attrs);
		}
	}
}

export function otelSink(opts: OtelSinkOptions): OtelMetricsSink {
	return new OtelMetricsSink(opts);
}
