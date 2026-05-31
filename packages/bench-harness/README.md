# @floe/bench-harness

Live-server bench harness for Floe Assistants. Hides subprocess
lifecycle, SSE parsing, percentile math, pass-matrix reporting, JSON
persistence — callers write scenarios + assertions only.

## Install

```sh
pnpm add -D @floe/bench-harness
```

## Trivial usage

```ts
import { runBench, contains } from '@floe/bench-harness';

await runBench({
  cwd: import.meta.dirname + '/..',
  models: ['openai/gpt-4.1-mini'],
  scenarios: [
    { id: 'greet', turns: [{ userMessage: 'hello', expect: [contains('hello')] }] },
  ],
});
```

That's a complete bench file. Spawns the example's `server.ts` with
`FLOE_MODEL=openai/gpt-4.1-mini`, runs the scenario, prints a pass
matrix + latency table, writes `test/__bench_run.json`.

## Multi-model sweep with a semantic judge

```ts
import { runBench, openAiJudge } from '@floe/bench-harness';
import { contains, semanticContains } from '@floe/runtime/eval';

const judge = openAiJudge({ model: 'gpt-4.1-mini' });

await runBench({
  cwd: import.meta.dirname + '/..',
  models: [
    { id: 'google/gemini-3.5-flash', thinking: 'low' },
    { id: 'openai/gpt-4.1-mini' },
  ],
  scenarios: [
    {
      id: 's1-sizing',
      turns: [{
        userMessage: 'What size for the Echo Pima T?',
        expect: [
          contains('echo'),
          semanticContains('size', { intent: 'gives sizing advice', judge }),
        ],
      }],
    },
  ],
});
```

## Multi-turn scenarios

`turns` is an array. Each turn reuses the same session id so the
Assistant carries state across user messages.

```ts
{
  id: 's-return',
  turns: [
    { userMessage: 'I want to return ord_2240', expect: [contains('refund')] },
    { userMessage: 'yes please', expect: [contains('processed')] },
  ],
}
```

## Escape hatches

- `server: false` — point the harness at an already-running server (you start it).
- `server: { port, cmd, readyPath, readyTimeoutMs }` — override the spawn shape.
- `warmup: false` — skip the throwaway pre-run.
- `reportPath: false` — don't persist the JSON.
- `printConsoleReport: false` — silent mode for CI.
- Custom assertions: implement the `Assertion` interface from `@floe/runtime/eval`.

## What's deliberately rigid

- **One server per model**, spawned via `FLOE_MODEL` env. Mid-run model
  switching isn't supported by the default API; drop to the lower-level
  `send`/`startServer` exports if you need it.
- **Sequential scenarios per model** by default — preserves deterministic
  TTFT measurements + avoids rate-limit fan-out.
- **SSE wire only.** The transport assumes the canonical OpenAI Chat
  Completions chunked SSE format every Floe HTTP surface ships.
