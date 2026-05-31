/**
 * @floe/jobs — background-worker primitive for Floe Assistants.
 *
 * Two layers:
 *
 *   1. `createJobRunner({ perform, concurrency?, store? })` — the
 *      in-process queue. Enqueue work, the runner processes it off
 *      the user's turn, listeners fire on completion.
 *
 *   2. `mountJobsMcp(runner, {port})` — exposes the runner as an MCP
 *      server so the Assistant's LLM can hit `mcp__jobs__enqueue` /
 *      `mcp__jobs__get` / `mcp__jobs__list` / `mcp__jobs__cancel` as
 *      ordinary tool calls.
 *
 * Why this exists: Flue's `task()` blocks the parent's turn via
 * `runExclusive`. Agno Teams' leader-decides-everything model has
 * the same shape (sync default; async-concurrent within one turn).
 * Neither ships true cross-turn background work. Personal-AI use
 * cases (chief-of-staff, knowledge-worker) need to delegate
 * minutes-long deep research while the user keeps talking — and
 * surface results in a later turn.
 *
 * See `templates/chief-of-staff/` for a worked example.
 */
export { createJobRunner } from './runner.ts';
export { InMemoryJobStore } from './in-memory-store.ts';
export { mountJobsMcp } from './mcp.ts';
export type {
	Job,
	JobStatus,
	JobFilter,
	JobStore,
	PerformFn,
	EnqueueArgs,
	JobRunner,
	JobRunnerOptions,
} from './types.ts';
