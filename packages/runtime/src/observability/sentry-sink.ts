/**
 * Sentry MetricsSink. Structurally typed against the public Sentry SDK
 * shape so no hard dep on `@sentry/node` / `@sentry/cloudflare` is added
 * to `@floe/runtime`. Users pass in their Sentry hub/client.
 *
 * Pushed as:
 *   - `breadcrumb` (category: 'floe.turn') for every turn
 *   - `metric.distribution(...)` for the total latency
 *   - `addAttachment` / `captureMessage` on terminal validator failures
 *     (escalate / disambiguate) so the on-call sees them
 */
import type { MetricsSink, TurnMetrics } from './types.ts';

interface SentryHubLike {
	addBreadcrumb(breadcrumb: {
		category?: string;
		message?: string;
		level?: 'debug' | 'info' | 'warning' | 'error' | 'fatal';
		data?: Record<string, unknown>;
		type?: string;
	}): void;
	captureMessage?(message: string, level?: 'info' | 'warning' | 'error'): void;
}

interface SentryMetricsLike {
	distribution?(name: string, value: number, options?: { unit?: string; tags?: Record<string, string> }): void;
}

export interface SentrySinkOptions {
	/** The Sentry hub/client (e.g. from `@sentry/node`'s `Sentry`). */
	client: SentryHubLike;
	/** Optional metrics surface (some Sentry SDKs expose it; pass through if you use it). */
	metrics?: SentryMetricsLike;
	/** Send escalations as `captureMessage('warning')`. Default true. */
	captureEscalations?: boolean;
}

export class SentryMetricsSink implements MetricsSink {
	readonly name = 'sentry';
	private readonly client: SentryHubLike;
	private readonly metrics?: SentryMetricsLike;
	private readonly captureEscalations: boolean;

	constructor(opts: SentrySinkOptions) {
		if (!opts.client) throw new Error('[SentryMetricsSink] client is required');
		this.client = opts.client;
		if (opts.metrics) this.metrics = opts.metrics;
		this.captureEscalations = opts.captureEscalations ?? true;
	}

	record(metrics: TurnMetrics): void {
		this.client.addBreadcrumb({
			category: 'floe.turn',
			message: `Floe turn ${metrics.runId} conv=${metrics.assistantName} reply=${metrics.producedReply}`,
			level: metrics.validatorVerdict === 'ok' ? 'info' : 'warning',
			type: 'default',
			data: {
				conversation: metrics.assistantName,
				agentId: metrics.routedTo ?? "",
				flowName: metrics.flowName,
				channelName: metrics.channelName,
				isVoice: metrics.isVoice,
				userId: metrics.userId,
				verdict: metrics.validatorVerdict,
				stages: metrics.stages,
				tokens: metrics.tokens,
				models: metrics.models,
			},
		});

		if (this.metrics?.distribution) {
			const tags = {
				conversation: metrics.assistantName,
				channel: metrics.channelName,
				agent: metrics.routedTo ?? 'unknown',
			};
			this.metrics.distribution('floe.turn.total_ms', metrics.stages.totalMs, { unit: 'millisecond', tags });
			this.metrics.distribution('floe.turn.llm_ms', metrics.stages.llmMs, { unit: 'millisecond', tags });
			this.metrics.distribution('floe.turn.input_tokens', metrics.tokens.input, { unit: 'none', tags });
			this.metrics.distribution('floe.turn.output_tokens', metrics.tokens.output, { unit: 'none', tags });
			this.metrics.distribution('floe.turn.cost_usd', metrics.tokens.totalCostUsd, { unit: 'none', tags });
		}

		if (
			this.captureEscalations &&
			this.client.captureMessage &&
			(metrics.validatorVerdict === 'escalate' || metrics.validatorVerdict === 'disambiguate')
		) {
			this.client.captureMessage(
				`Floe ${metrics.validatorVerdict} in conv=${metrics.assistantName} turn=${metrics.runId}`,
				'warning',
			);
		}
	}
}

export function sentrySink(opts: SentrySinkOptions): SentryMetricsSink {
	return new SentryMetricsSink(opts);
}
