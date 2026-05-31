# Evaluation framework

Floe ships a scenario-based eval framework — declarative test cases, built-in assertions, baseline regression diffing — so you can catch quality drift before it ships.

## Concept

```
defineScenario({
  id: 'pricing-pro',
  given: { conversation: 'support', sessionId: 'eval-pricing-pro' },
  when: { userMessage: 'How much does the Pro plan cost?' },
  expect: [
    contains('$12'),
    notContains('refund'),
    matches(/per\s+user/i),
    costBelow(0.01),
    latencyBelow(2000),
  ],
});
```

The runner drives a `Floe` instance against each scenario, captures every event + the final text + metrics, then runs each assertion. A `RunReport` aggregates pass/fail counts.

## Built-in assertions

| Assertion | What it checks |
|---|---|
| `contains(needle)` | Final reply contains the substring (case-insensitive) |
| `notContains(needle)` | Final reply doesn't contain it |
| `matches(regex)` | Final reply matches the regex |
| `enteredFlow(name)` | Conversation entered the named flow at least once |
| `noFlowEntered()` | No `flow_enter` event was emitted (single-agent path) |
| `mentionsNode(name)` | Conversation entered or exited the named flow node |
| `costBelow(usd)` | Total cost across all turns under USD budget |
| `latencyBelow(ms)` | Total turn latency under ms budget |
| `llmJudge({ session, rubric, threshold })` | An LLM scores the reply against a rubric; passes when score ≥ threshold |

## Custom assertions

Implement `Assertion` — `{ name, check(ctx) }`:

```ts
import type { Assertion } from '@floe/runtime/eval';

const mentionsPrice: Assertion = {
  name: 'mentionsPrice',
  check(ctx) {
    return /\$\d+/.test(ctx.text)
      ? { pass: true }
      : { pass: false, message: 'no $price in reply' };
  },
};
```

`AssertionContext` exposes:
- `text` — final assistant reply
- `allTexts` — all replies across multi-step scenarios
- `events` — full ConversationOutputEvent stream
- `state` — final ConversationState
- `metrics` — TurnMetrics from each turn (when observability is wired)

## Running

### HTTP-shaped runner (recommended)

For running against a live Floe deployment:

```ts
import { runScenariosOverHttp } from '@floe/runtime/eval';

const report = await runScenariosOverHttp({
  scenarios: [/* ... */],
  baseUrl: 'http://localhost:3593',
  agentPath: '/agents/web',
  concurrency: 5,
});

console.log(`${report.passed}/${report.totalScenarios} passed`);
```

### In-process runner

Drives Floe directly without HTTP — useful for unit-test-style usage:

```ts
import { runScenarios } from '@floe/runtime/eval';

const report = await runScenarios({
  floe,
  scenarios: [/* ... */],
  concurrency: 1,
  onScenarioComplete: (r) => console.log(`${r.scenarioId}: ${r.pass ? 'PASS' : 'FAIL'}`),
});
```

The in-process runner expects callers to provide a Floe instance that can be driven without a real Flue HTTP context. Recommended for scripted CI evals where you spin a Flue dev server and use `runScenariosOverHttp` against it.

## Baseline regression

Persist a run as the baseline, then diff future runs against it:

```ts
import { saveBaseline, loadBaseline, diffAgainstBaseline, formatDiff } from '@floe/runtime/eval';

// First run — establish baseline
const initial = await runScenariosOverHttp({ /* ... */ });
saveBaseline(initial, './eval-baseline.json');

// Subsequent runs — diff
const current = await runScenariosOverHttp({ /* ... */ });
const diff = diffAgainstBaseline(current, loadBaseline('./eval-baseline.json'));
console.log(formatDiff(diff));
//   ❌ REGRESSIONS (2): - pricing-pro - refund-multi-turn
//   ✅ IMPROVEMENTS (1): - linux-support
//   ➕ NEW (1): - vat-question (PASS)
if (diff.regressions.length > 0) process.exit(1);
```

Wire this into your CI: `git diff main HEAD --` finds prompt/agent changes, eval catches behavior drift.

## LLM-as-judge

Use a separate LLM to score the reply against a rubric:

```ts
import { llmJudge } from '@floe/runtime/eval';

llmJudge({
  session: judgeSession, // any FlueSession (recommend a cheap, fast model)
  rubric: 'The reply must explain the Pro plan price and mention the annual discount.',
  threshold: 0.7,
});
```

Non-deterministic — pair with low-temperature models and a generous threshold for stable runs.

## Multi-step scenarios

```ts
defineScenario({
  id: 'refund-confirm',
  given: { sessionId: 'eval-refund' },
  when: [
    { userMessage: 'I want a refund for invoice inv_881' },
    { userMessage: 'Yes, please process it' },
  ],
  expect: [
    contains('refund'),
    mentionsNode('ask-confirmation'),
    enteredFlow('refund'),
  ],
});
```

Each `when` step runs as a separate turn against the same `sessionId`. The session state carries between steps via Flue's persistent SessionStore (DO SQLite on CF, in-memory on Node).

## Tags + filtering

```ts
defineScenario({
  id: 'pricing-pro',
  tags: ['regression', 'pricing'],
  /* ... */
});

// Filter at run time
const filtered = scenarios.filter((s) => s.tags?.includes('regression'));
await runScenariosOverHttp({ scenarios: filtered, baseUrl: '...' });
```

## CI snippet

```yaml
# .github/workflows/eval.yml
- name: Floe eval
  run: |
    pnpm --filter @floe/example-support-bot build
    node examples/support-bot/dist/server.mjs &
    SERVER_PID=$!
    sleep 3
    pnpm tsx test/eval-suite.ts
    EXIT=$?
    kill $SERVER_PID
    exit $EXIT
  env:
    GOOGLE_GENERATIVE_AI_API_KEY: ${{ secrets.GEMINI_KEY }}
```
