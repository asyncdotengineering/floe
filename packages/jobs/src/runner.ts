/**
 * `createJobRunner` — the heart of @floe/jobs.
 *
 * A small in-process queue that runs `perform(job)` up to `concurrency`
 * in parallel. Jobs go queued → running → done|failed|cancelled.
 * `onComplete` listeners fire once per terminal transition.
 *
 * Why this exists: Flue's `task()` blocks the parent session's turn
 * via `runExclusive`. Agno Teams' leader blocks until member synthesis.
 * Neither ships a true "fire-and-forget, continue talking, check
 * results in a future turn" pattern. Personal-AI templates
 * (chief-of-staff, knowledge-worker) need it.
 *
 * Scope: focused. No retries with backoff, no DLQ, no scheduling. Add
 * those when a template actually needs them; YAGNI until then.
 */
import { InMemoryJobStore } from './in-memory-store.ts';
import type {
	EnqueueArgs,
	Job,
	JobFilter,
	JobRunner,
	JobRunnerOptions,
	JobStore,
} from './types.ts';

export function createJobRunner(opts: JobRunnerOptions): JobRunner {
	const store: JobStore = opts.store ?? new InMemoryJobStore();
	const concurrency = opts.concurrency ?? 4;
	const perform = opts.perform;

	const pending: Job[] = []; // queued, FIFO
	const inFlight = new Set<string>();
	const listeners = new Set<(j: Job) => void | Promise<void>>();
	let stopped = false;

	const fireListeners = async (job: Job): Promise<void> => {
		for (const cb of listeners) {
			try {
				await cb(structuredClone(job));
			} catch (err) {
				console.error('[floe:jobs] onComplete listener threw:', err);
			}
		}
	};

	const tryDrain = (): void => {
		while (!stopped && inFlight.size < concurrency && pending.length > 0) {
			const job = pending.shift()!;
			inFlight.add(job.id);
			void runOne(job);
		}
	};

	const runOne = async (job: Job): Promise<void> => {
		const running: Job = { ...job, status: 'running', startedAt: new Date().toISOString() };
		await store.save(running);
		let terminal: Job;
		try {
			const result = await perform(structuredClone(running));
			terminal = {
				...running,
				status: 'done',
				finishedAt: new Date().toISOString(),
				result,
			};
		} catch (err) {
			terminal = {
				...running,
				status: 'failed',
				finishedAt: new Date().toISOString(),
				error: err instanceof Error ? err.message : String(err),
			};
		}
		await store.save(terminal);
		inFlight.delete(job.id);
		await fireListeners(terminal);
		tryDrain();
	};

	return {
		async enqueue(args: EnqueueArgs): Promise<Job> {
			if (stopped) throw new Error('[floe:jobs] runner has been stopped');
			const job: Job = {
				id: `job_${Math.random().toString(36).slice(2, 10)}`,
				worker: args.worker,
				prompt: args.prompt,
				status: 'queued',
				enqueuedAt: new Date().toISOString(),
				...(args.metadata ? { metadata: args.metadata } : {}),
				...(args.checkInAfter ? { checkInAfter: args.checkInAfter } : {}),
			};
			await store.save(job);
			pending.push(job);
			tryDrain();
			return structuredClone(job);
		},
		async get(id: string) {
			return store.get(id);
		},
		async list(filter?: JobFilter) {
			return store.list(filter);
		},
		async cancel(id: string) {
			const current = await store.get(id);
			if (!current) return null;
			if (current.status === 'done' || current.status === 'failed' || current.status === 'cancelled') {
				return current;
			}
			// If still queued (not yet drained), pop it.
			const idx = pending.findIndex((j) => j.id === id);
			if (idx >= 0) pending.splice(idx, 1);
			const cancelled: Job = {
				...current,
				status: 'cancelled',
				finishedAt: new Date().toISOString(),
			};
			await store.save(cancelled);
			await fireListeners(cancelled);
			return cancelled;
			// Note: in-flight jobs are NOT interrupted — `perform` doesn't
			// receive a signal in v1. Add when a real use case demands it.
		},
		onComplete(cb) {
			listeners.add(cb);
			return () => {
				listeners.delete(cb);
			};
		},
		get active() {
			return inFlight.size;
		},
		async stop() {
			stopped = true;
			pending.length = 0;
			while (inFlight.size > 0) {
				await new Promise((r) => setTimeout(r, 50));
			}
		},
	};
}
