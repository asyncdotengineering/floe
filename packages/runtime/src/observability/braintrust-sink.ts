/**
 * Braintrust MetricsSink. Pushes each turn as a span+log in a Braintrust
 * project so downstream evals + dashboards can analyze quality + latency
 * over time. Structural type — no hard dep on `braintrust` SDK.
 *
 * The `logger` you pass is whatever your Braintrust SDK gave you:
 *   const logger = initLogger({ projectName: 'floe-support', apiKey: '...' });
 *   floe = new Floe({ defaults: { observability: { sinks: [braintrustSink({ logger })] }}});
 */
import type { MetricsSink, TurnMetrics } from './types.ts';

interface BraintrustLoggerLike {
	log(args: { input?: unknown; output?: unknown; metrics?: Record<string, number>; metadata?: Record<string, unknown>; scores?: Record<string, number> }): void | Promise<void>;
}

export interface BraintrustSinkOptions {
	logger: BraintrustLoggerLike;
}

export class BraintrustMetricsSink implements MetricsSink {
	readonly name = 'braintrust';
	private readonly logger: BraintrustLoggerLike;

	constructor(opts: BraintrustSinkOptions) {
		if (!opts.logger) throw new Error('[BraintrustMetricsSink] logger is required');
		this.logger = opts.logger;
	}

	async record(metrics: TurnMetrics): Promise<void> {
		await this.logger.log({
			input: { conversation: metrics.assistantName, agentId: metrics.routedTo ?? "", flowName: metrics.flowName },
			output: { producedReply: metrics.producedReply, verdict: metrics.validatorVerdict },
			metrics: {
				total_ms: metrics.stages.totalMs,
				triage_ms: metrics.stages.triageMs,
				knowledge_ms: metrics.stages.knowledgeMs,
				memory_preload_ms: metrics.stages.memoryPreloadMs,
				prelvm_validators_ms: metrics.stages.preLLMValidatorsMs,
				prompt_build_ms: metrics.stages.promptBuildMs,
				llm_ms: metrics.stages.llmMs,
				postlvm_validators_ms: metrics.stages.postLLMValidatorsMs,
				memory_ingest_ms: metrics.stages.memoryIngestMs,
				input_tokens: metrics.tokens.input,
				output_tokens: metrics.tokens.output,
				cache_read_tokens: metrics.tokens.cacheRead,
				cache_write_tokens: metrics.tokens.cacheWrite,
				cost_usd: metrics.tokens.totalCostUsd,
				memory_preload_count: metrics.memoryPreloadCount,
			},
			metadata: {
				runId: metrics.runId,
				userId: metrics.userId,
				channel: metrics.channelName,
				isVoice: metrics.isVoice,
				models: metrics.models,
				knowledge: metrics.knowledge,
				triage: metrics.routedTo,
				tags: metrics.tags,
			},
		});
	}
}

export function braintrustSink(opts: BraintrustSinkOptions): BraintrustMetricsSink {
	return new BraintrustMetricsSink(opts);
}
