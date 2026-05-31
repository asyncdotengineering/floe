/**
 * `mountJobsMcp(runner, {port})` — exposes a `JobRunner` over an MCP
 * Streamable-HTTP endpoint so the Assistant's LLM can hit
 * `mcp__jobs__enqueue` / `mcp__jobs__get` / `mcp__jobs__list` /
 * `mcp__jobs__cancel` as ordinary tool calls.
 *
 * Built on `@floe/mock-services`'s `defineMockService` + `mountMockMcp`
 * primitives, but the underlying STORE is the live JobRunner — not an
 * in-memory mock. Production deployments swap the JobStore (libSQL,
 * Postgres, Redis) and reuse the same MCP entrypoint.
 *
 * The returned `MockMcpHandle` drops straight into
 * `Assistant({ mcp: [...] })` like any other MCP server.
 */
import * as v from 'valibot';
import { defineMockService, mountMockMcp, type MockMcpHandle } from '@floe/mock-services';
import type { Job, JobRunner } from './types.ts';

/**
 * The MCP store row shape. We mirror the Job into a dummy row keyed
 * by id so `defineMockService`'s `Store<T>` type is happy — but every
 * operation delegates back to the live `JobRunner` for actual state.
 */
interface JobRow {
	id: string;
}

const ALL_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;

export async function mountJobsMcp(
	runner: JobRunner,
	opts: { port: number },
): Promise<MockMcpHandle> {
	const svc = await defineMockService<JobRow>({
		name: 'jobs',
		operations: {
			enqueue: {
				description:
					"Enqueue a background job. Returns the job id IMMEDIATELY — the work runs off the user's turn. Use this for any task expected to take more than 10-15 seconds (deep research, long syntheses, large doc reads). Tell the user the job id + check back later. Mark `checkInAfter` (ISO 8601) when you want to remind yourself to surface results.",
				input: v.object({
					worker: v.string(),
					prompt: v.string(),
					metadata: v.optional(v.record(v.string(), v.unknown())),
					checkInAfter: v.optional(v.string()),
				}),
				handler: async (args) => {
					const job = await runner.enqueue({
						worker: args.worker,
						prompt: args.prompt,
						...(args.metadata ? { metadata: args.metadata } : {}),
						...(args.checkInAfter ? { checkInAfter: args.checkInAfter } : {}),
					});
					return jobToWire(job);
				},
			},
			get: {
				description:
					'Fetch a job by id. Use this when a previous turn enqueued work and you want to check whether it finished.',
				input: v.object({ id: v.string() }),
				handler: async ({ id }) => {
					const job = await runner.get(id);
					return job ? jobToWire(job) : null;
				},
			},
			list: {
				description:
					'List jobs. Optional filters: status (queued/running/done/failed/cancelled — single or array) and worker.',
				input: v.object({
					status: v.optional(v.union([v.picklist(ALL_STATUSES), v.array(v.picklist(ALL_STATUSES))])),
					worker: v.optional(v.string()),
				}),
				handler: async ({ status, worker }) => {
					const filter: { status?: typeof ALL_STATUSES[number] | typeof ALL_STATUSES[number][]; worker?: string } = {};
					if (status) filter.status = status;
					if (worker) filter.worker = worker;
					const jobs = await runner.list(filter);
					return jobs
						.map(jobToWire)
						.sort((a, b) =>
							String(b['enqueuedAt']).localeCompare(String(a['enqueuedAt'])),
						);
				},
			},
			cancel: {
				description:
					'Cancel a queued job. In-flight jobs are NOT interrupted (v1 limitation) — they will finish.',
				input: v.object({ id: v.string() }),
				handler: async ({ id }) => {
					const job = await runner.cancel(id);
					return job ? jobToWire(job) : null;
				},
			},
		},
	});
	return mountMockMcp(svc, { port: opts.port });
}

function jobToWire(job: Job): Record<string, unknown> {
	return {
		id: job.id,
		worker: job.worker,
		prompt: job.prompt,
		status: job.status,
		enqueuedAt: job.enqueuedAt,
		...(job.startedAt ? { startedAt: job.startedAt } : {}),
		...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
		...(job.result ? { result: job.result } : {}),
		...(job.error ? { error: job.error } : {}),
		...(job.metadata ? { metadata: job.metadata } : {}),
		...(job.checkInAfter ? { checkInAfter: job.checkInAfter } : {}),
	};
}
