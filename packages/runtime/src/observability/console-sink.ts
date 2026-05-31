/**
 * Console MetricsSink. One JSON-line per turn, written to stderr. Useful
 * in dev and as a fallback in CI. Production deployments should pair
 * with a real sink (Sentry / Braintrust / OTel).
 */
import type { MetricsSink, TurnMetrics } from './types.ts';

export interface ConsoleSinkOptions {
	/** 'json' (default) emits NDJSON; 'pretty' emits a multi-line summary for human reads. */
	format?: 'json' | 'pretty';
	/** Override the writer; defaults to console.error. */
	write?: (line: string) => void;
}

export class ConsoleMetricsSink implements MetricsSink {
	readonly name = 'console';
	private readonly format: 'json' | 'pretty';
	private readonly write: (line: string) => void;

	constructor(opts: ConsoleSinkOptions = {}) {
		this.format = opts.format ?? 'json';
		this.write = opts.write ?? ((s) => console.error(s));
	}

	record(metrics: TurnMetrics): void {
		this.write(this.format === 'json' ? JSON.stringify(metrics) : pretty(metrics));
	}
}

function pretty(m: TurnMetrics): string {
	return [
		`[floe:metrics] turn=${m.runId} conv=${m.assistantName} agent=${(m.routedTo ?? "") ?? '-'} flow=${m.flowName ?? '-'} channel=${m.channelName}${m.isVoice ? ' (voice)' : ''}`,
		`  user=${m.userId ?? '-'} verdict=${m.validatorVerdict} reply=${m.producedReply}`,
		`  latency total=${m.stages.totalMs}ms triage=${m.stages.triageMs} knowledge=${m.stages.knowledgeMs} memory=${m.stages.memoryPreloadMs} preV=${m.stages.preLLMValidatorsMs} prompt=${m.stages.promptBuildMs} llm=${m.stages.llmMs} postV=${m.stages.postLLMValidatorsMs} ingest=${m.stages.memoryIngestMs}`,
		`  tokens in=${m.tokens.input} out=${m.tokens.output} cost=$${m.tokens.totalCostUsd.toFixed(6)} models=${m.models.join(',')}`,
	].join('\n');
}

export function consoleSink(opts?: ConsoleSinkOptions): ConsoleMetricsSink {
	return new ConsoleMetricsSink(opts);
}
