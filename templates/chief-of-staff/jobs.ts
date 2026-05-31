/**
 * Background-jobs lifecycle for chief-of-staff.
 *
 * The CoS gets a `mcp__jobs__*` tool surface so the LLM can:
 *   - `enqueue` long work (deep-research, multi-doc synthesis) without
 *     blocking the user's turn
 *   - `get`/`list` jobs in later turns to surface results
 *   - `cancel` jobs that are no longer needed
 *
 * Each enqueued job runs on a FRESH session id (`job-<job.id>`) so its
 * conversation history is isolated from the user's main session. The
 * job's `worker` field is surfaced in the prompt prefix so the
 * Assistant can act in the appropriate role.
 *
 * Production hardening:
 *   - swap `InMemoryJobStore` for a libSQL-backed store so jobs
 *     survive process restarts
 *   - add `onComplete` listener to fire a Slack DM / webhook when a
 *     long-running job finishes (so the leader doesn't have to ask)
 *   - cap `concurrency` to your provider's rate limits
 */
import { createJobRunner, mountJobsMcp, type JobRunner } from '@floe/jobs';
import type { MockMcpHandle } from '@floe/mock-services';
import type { Assistant } from '@floe/runtime';

export interface JobsBundle {
	runner: JobRunner;
	mcp: MockMcpHandle;
	stop(): Promise<void>;
}

/**
 * Build the JobRunner + its MCP server. Takes a factory that returns
 * the Assistant — avoids a circular dep with the Assistant config
 * (the Assistant's mcp[] needs the mcp handle; the runner's perform
 * needs the Assistant).
 */
export async function mountJobs(args: {
	port: number;
	getAssistant: () => Assistant;
	concurrency?: number;
}): Promise<JobsBundle> {
	const runner = createJobRunner({
		concurrency: args.concurrency ?? 3,
		async perform(job) {
			// Each background job runs on its own session id. The Assistant
			// applies its full system prompt + role registry, so we
			// instruct the LLM via the prompt prefix to act AS the named
			// worker for this turn.
			const assistant = args.getAssistant();
			const result = await assistant.run(
				`(BACKGROUND JOB — act as the '${job.worker}' role for this turn. ` +
					`Do not delegate further; produce the final result directly.)\n\n` +
					job.prompt,
				{
					sessionId: `job-${job.id}`,
					userId: 'system:jobs',
					metadata: {
						background: true,
						jobId: job.id,
						worker: job.worker,
						...(job.metadata ?? {}),
					},
				},
			);
			return (result.content ?? '').trim() || '(no result text)';
		},
	});

	const mcp = await mountJobsMcp(runner, { port: args.port });
	console.log(`[chief-of-staff:jobs] runner ready (concurrency=${args.concurrency ?? 3}) → ${mcp.url}`);

	return {
		runner,
		mcp,
		async stop() {
			await mcp.stop();
			await runner.stop();
		},
	};
}
