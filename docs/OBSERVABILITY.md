# Observability

Floe ships per-turn structured metrics with pluggable sinks (Console / Sentry / Braintrust / OpenTelemetry) so production deployments can answer "what happened, when, and at what cost" without parsing logs.

## What gets captured

Every turn produces a `TurnMetrics` record:

```ts
interface TurnMetrics {
  runId: string;                  // Flue ctx.runId
  conversation: string;
  agentId: string | null;
  flowName: string | null;
  channelName: string;
  isVoice: boolean;
  userId: string | null;
  startedAtMs: number;
  endedAtMs: number;
  stages: {                        // per-stage latency decomposition
    triageMs, knowledgeMs, memoryPreloadMs,
    preLLMValidatorsMs, promptBuildMs,
    llmMs, postLLMValidatorsMs, memoryIngestMs,
    totalMs,
  };
  tokens: { input, output, cacheRead, cacheWrite, totalCostUsd };
  models: string[];                 // model(s) used (chain on failover)
  producedReply: boolean;
  validatorVerdict: 'ok' | 'retry' | 'escalate' | 'rewrite' | 'disambiguate' | 'block';
  knowledge: { source: string; chunks: number }[];
  memoryPreloadCount: number;
  triage: { mode, routedTo } | null;
}
```

The orchestrator captures these timestamps automatically and fans the record out to every configured sink.

## Sinks

### Console (dev, fallback)

```ts
import { consoleSink } from '@floe/runtime/observability';

new Floe({
  defaults: {
    model: '...',
    observability: { sinks: [consoleSink({ format: 'pretty' })] },
  },
});
```

Writes one JSON line per turn to stderr (default) or a human-readable summary (`format: 'pretty'`).

### Sentry

```ts
import * as Sentry from '@sentry/node';
import { sentrySink } from '@floe/runtime/observability';

Sentry.init({ dsn: process.env.SENTRY_DSN });

new Floe({
  defaults: {
    model: '...',
    observability: { sinks: [sentrySink({ client: Sentry })] },
  },
});
```

Emits:
- `addBreadcrumb({ category: 'floe.turn', ... })` per turn — visible on subsequent errors
- `metrics.distribution('floe.turn.total_ms', ...)` etc. when `Sentry.metrics` exists
- `captureMessage(...)` on escalate / disambiguate verdicts so on-call is paged

Structural typing means **no hard `@sentry/*` dep** — Floe doesn't pin you to a specific Sentry SDK version.

### Braintrust

```ts
import { initLogger } from 'braintrust';
import { braintrustSink } from '@floe/runtime/observability';

const logger = initLogger({ projectName: 'floe-support', apiKey: process.env.BRAINTRUST_API_KEY });

new Floe({
  defaults: {
    model: '...',
    observability: { sinks: [braintrustSink({ logger })] },
  },
});
```

Logs each turn as a Braintrust span with full metrics + metadata. Pair with Braintrust's eval framework for offline regression testing.

### OpenTelemetry

```ts
import { trace, metrics } from '@opentelemetry/api';
import { otelSink } from '@floe/runtime/observability';

const tracer = trace.getTracer('floe', '0.1.0');
const meter = metrics.getMeter('floe', '0.1.0');

new Floe({
  defaults: {
    model: '...',
    observability: { sinks: [otelSink({ tracer, meter })] },
  },
});
```

Per turn:
- One span `floe.turn <conversation>` with all per-stage attributes
- Histograms: `floe.turn.total_ms`, `floe.turn.llm_ms`, `floe.turn.tokens_in`, `floe.turn.tokens_out`, `floe.turn.cost_usd`

### Multiple sinks

You can attach as many as you like — Floe fans out to all in order. Sinks are **non-blocking** by default; a slow Sentry POST doesn't slow the user's response.

```ts
observability: {
  sinks: [consoleSink(), sentrySink({ client: Sentry }), otelSink({ tracer })],
  sampleRate: 0.1,    // sample 10% of turns
  awaitSinks: false,  // default
}
```

Set `awaitSinks: true` in tests for determinism (the eval framework does this automatically).

## Replay

Replay a captured event stream — useful for debugging, time-travel UIs, and rebuilding transcripts:

```ts
import { replayEvents, transcriptFromEvents } from '@floe/runtime/observability';

const transcript = transcriptFromEvents(turnResult.events);
//   → [{ role: 'assistant', text: '...' }, ...]

await replayEvents(turnResult.events, {
  intervalMs: 100,
  onEvent: (event, ctx) => {
    console.log(`Event ${ctx.index}/${ctx.total}:`, event.type);
  },
});
```

## Custom sinks

Implement `MetricsSink` — it's just `{ name, record(metrics) }`:

```ts
import type { MetricsSink, TurnMetrics } from '@floe/runtime/observability';

class DatadogSink implements MetricsSink {
  readonly name = 'datadog';
  async record(m: TurnMetrics): Promise<void> {
    await fetch('https://api.datadoghq.com/api/v2/series', { /* ... */ });
  }
}
```

## Cost monitoring

The `tokens.totalCostUsd` field uses pi-ai's published per-million-token rates (verified against each provider). Pair with the `costBelow` eval assertion to fail builds when scenarios regress on cost:

```ts
import { costBelow } from '@floe/runtime/eval';

defineScenario({
  id: 'basic-query',
  /* ... */
  expect: [contains('hello'), costBelow(0.005)],
});
```
