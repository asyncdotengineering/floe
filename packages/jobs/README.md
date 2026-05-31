# @floe/jobs

Background-worker primitive for Floe Assistants. Enqueue work, the
runner processes it **off the user's turn**, the Assistant's LLM
checks status / fetches results in later turns via the bundled MCP
server.

## Why

Flue's `task()` blocks the parent session's turn (`runExclusive`
holds the session lock until the child completes). Agno Teams' leader
also blocks until member synthesis — async mode runs members
concurrently but the leader still waits. **Neither framework ships
true cross-turn background work** — both are within-turn synchronous.

For personal-AI templates (chief-of-staff, knowledge-worker) this is
the wrong default: "deep-research the Globex security review with the
customer team" is a 5-minute task. The user shouldn't wait inline.
They want "I'm on it, will surface when ready" and continue the
conversation.

`@floe/jobs` fills that gap.

## Install

```sh
pnpm add @floe/jobs
```

## Usage — direct (one-liner per call)

```ts
import { createJobRunner } from '@floe/jobs';

const runner = createJobRunner({
  concurrency: 4,
  async perform(job) {
    // Run on a fresh sessionId so the work has isolated history.
    const result = await myAssistant.run(job.prompt, {
      sessionId: `job-${job.id}`,
      userId: 'system:jobs',
    });
    return result.content;
  },
});

const job = await runner.enqueue({
  worker: 'deep-researcher',
  prompt: 'Pull the Globex security review state from email + Linear + Notion. Summarize blockers.',
  checkInAfter: '2026-05-25T17:00:00Z',
});
// Returns immediately; work runs in the background.

const later = await runner.get(job.id);
if (later?.status === 'done') console.log(later.result);
```

## Usage — via MCP (the LLM-facing path)

Mount the runner as an MCP server and add it to your Assistant config.
The LLM then calls `mcp__jobs__enqueue` / `mcp__jobs__get` /
`mcp__jobs__list` / `mcp__jobs__cancel` as ordinary tools.

```ts
import { createJobRunner, mountJobsMcp } from '@floe/jobs';
import { Assistant } from '@floe/runtime';

const runner = createJobRunner({ perform: async (j) => /* … */ });
const jobsMcp = await mountJobsMcp(runner, { port: 4500 });

export const assistant = new Assistant({
  // …
  mcp: [
    // …other servers
    { name: jobsMcp.name, url: jobsMcp.url }, // exposes mcp__jobs__*
  ],
});
```

Tell the LLM (in `systemPrompt` or `AGENTS.md`):

> For any task expected to take more than 10-15 seconds (deep
> research, long syntheses, large doc reads), use
> `mcp__jobs__enqueue` and tell the user the job id. Don't wait
> inline. In a later turn, check `mcp__jobs__get(id)` and surface
> the result.

## API

```ts
createJobRunner({
  perform: (job: Job) => Promise<string>,  // your work fn
  concurrency?: number,                     // default 4
  store?: JobStore,                         // default InMemoryJobStore
}): JobRunner

JobRunner.enqueue({worker, prompt, metadata?, checkInAfter?}): Promise<Job>
JobRunner.get(id): Promise<Job | null>
JobRunner.list({status?, worker?}): Promise<Job[]>
JobRunner.cancel(id): Promise<Job | null>
JobRunner.onComplete(cb: (job) => void): () => void  // unsubscribe
JobRunner.active: number                              // in-flight count
JobRunner.stop(): Promise<void>                       // wait + refuse new

mountJobsMcp(runner, {port}): Promise<MockMcpHandle>
```

`Job.status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'`

## What's deliberately NOT in v1

- **Retries with backoff** — your `perform` is the source of truth;
  retry inside if you want.
- **Dead-letter queue** — `failed` jobs sit in the store; reap on your
  schedule.
- **Cron / scheduled jobs** — for now, the user (or a Linear automation)
  enqueues. If real templates need it, add `enqueueAt`.
- **In-flight cancellation** — `cancel` pops queued jobs and marks
  status, but in-flight jobs aren't interrupted. The runner doesn't
  thread an `AbortSignal` into `perform` yet — add when a real use
  case demands it.
- **Persistence** — `InMemoryJobStore` is the only bundled store.
  Implement the `JobStore` interface to back with libSQL / Postgres /
  Redis. Same shape as `@floe/runtime`'s memory stores.

These are intentional cuts. Ship the focused primitive; add when used.

## Tests

```sh
pnpm --filter @floe/jobs test
```
