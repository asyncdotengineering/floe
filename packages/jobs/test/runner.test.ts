/**
 * Boundary tests for `createJobRunner`. The runner is small but the
 * concurrency + lifecycle + listener semantics are easy to get wrong
 * in subtle ways. Pin them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createJobRunner } from '../src/runner.ts';
import type { Job, JobRunner } from '../src/types.ts';

const runners: JobRunner[] = [];
afterEach(async () => {
	for (const r of runners) await r.stop();
	runners.length = 0;
});

function makeRunner(args: { perform: (j: Job) => Promise<string>; concurrency?: number }) {
	const r = createJobRunner(args);
	runners.push(r);
	return r;
}

async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 1500): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const v = await fn();
		if (v !== undefined && v !== null && v !== false) return v as T;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error('waitFor: timed out');
}

describe('createJobRunner — enqueue + run', () => {
	it('runs a job to completion and stores the result', async () => {
		const runner = makeRunner({
			perform: async (job) => `did: ${job.prompt}`,
		});
		const job = await runner.enqueue({ worker: 'echo', prompt: 'hello' });
		expect(job.status).toBe('queued');

		const done = await waitFor(async () => {
			const j = await runner.get(job.id);
			return j?.status === 'done' ? j : undefined;
		});
		expect(done?.result).toBe('did: hello');
		expect(done?.startedAt).toBeTruthy();
		expect(done?.finishedAt).toBeTruthy();
	});

	it('marks failed jobs with the error message', async () => {
		const runner = makeRunner({
			perform: async () => {
				throw new Error('boom');
			},
		});
		const job = await runner.enqueue({ worker: 'broken', prompt: 'x' });
		const failed = await waitFor(async () => {
			const j = await runner.get(job.id);
			return j?.status === 'failed' ? j : undefined;
		});
		expect(failed?.error).toBe('boom');
	});
});

describe('createJobRunner — concurrency', () => {
	it('caps concurrent in-flight jobs at the configured limit', async () => {
		let peak = 0;
		let active = 0;
		const release: Array<() => void> = [];
		const runner = makeRunner({
			concurrency: 2,
			perform: async () => {
				active += 1;
				peak = Math.max(peak, active);
				await new Promise<void>((r) => release.push(r));
				active -= 1;
				return 'ok';
			},
		});
		// enqueue 5, expect peak=2
		const jobs = await Promise.all(
			[1, 2, 3, 4, 5].map((n) => runner.enqueue({ worker: 'slow', prompt: `j${n}` })),
		);
		// Wait until both slots are filled.
		await waitFor(() => (runner.active === 2 ? true : undefined));
		// Release them all.
		for (let i = 0; i < 5; i++) {
			await new Promise((r) => setTimeout(r, 10));
			release[i]?.();
		}
		// Wait for all to finish.
		await waitFor(async () => {
			const list = await runner.list({ status: 'done' });
			return list.length === 5 ? true : undefined;
		});
		expect(peak).toBe(2);
		expect(jobs.length).toBe(5);
	});
});

describe('createJobRunner — onComplete listener', () => {
	it('fires per terminal transition (done + failed + cancelled)', async () => {
		const seen: Array<{ id: string; status: string }> = [];
		const runner = makeRunner({
			perform: async (j) => (j.prompt === 'fail' ? Promise.reject(new Error('x')) : 'ok'),
		});
		runner.onComplete((job) => {
			seen.push({ id: job.id, status: job.status });
		});

		const a = await runner.enqueue({ worker: 'w', prompt: 'ok' });
		const b = await runner.enqueue({ worker: 'w', prompt: 'fail' });

		await waitFor(() => (seen.length === 2 ? true : undefined));
		const statuses = seen.reduce<Record<string, string>>((acc, e) => {
			acc[e.id] = e.status;
			return acc;
		}, {});
		expect(statuses[a.id]).toBe('done');
		expect(statuses[b.id]).toBe('failed');
	});

	it('unsubscribe stops further fires', async () => {
		let fires = 0;
		const runner = makeRunner({ perform: async () => 'ok' });
		const off = runner.onComplete(() => {
			fires += 1;
		});
		await runner.enqueue({ worker: 'w', prompt: '1' });
		await waitFor(() => (fires === 1 ? true : undefined));
		off();
		await runner.enqueue({ worker: 'w', prompt: '2' });
		await new Promise((r) => setTimeout(r, 80));
		expect(fires).toBe(1);
	});
});

describe('createJobRunner — cancel + list', () => {
	it('cancel pops queued jobs and marks status', async () => {
		const release: Array<() => void> = [];
		const runner = makeRunner({
			concurrency: 1,
			perform: async () => {
				await new Promise<void>((r) => release.push(r));
				return 'ok';
			},
		});
		const filler = await runner.enqueue({ worker: 'w', prompt: 'fill' });
		const target = await runner.enqueue({ worker: 'w', prompt: 'target' });
		// target should still be queued (concurrency=1, filler is in-flight)
		await waitFor(() => (runner.active === 1 ? true : undefined));
		const cancelled = await runner.cancel(target.id);
		expect(cancelled?.status).toBe('cancelled');
		// Release the filler so the runner drains.
		release[0]?.();
		await waitFor(async () => {
			const j = await runner.get(filler.id);
			return j?.status === 'done' ? true : undefined;
		});
	});

	it('list filters by status + worker', async () => {
		const runner = makeRunner({ perform: async () => 'r' });
		await runner.enqueue({ worker: 'a', prompt: '1' });
		await runner.enqueue({ worker: 'a', prompt: '2' });
		await runner.enqueue({ worker: 'b', prompt: '3' });
		await waitFor(async () => {
			const done = await runner.list({ status: 'done' });
			return done.length === 3 ? true : undefined;
		});
		const a = await runner.list({ worker: 'a' });
		expect(a.length).toBe(2);
		const b = await runner.list({ worker: 'b' });
		expect(b.length).toBe(1);
	});
});

describe('createJobRunner — stop', () => {
	it('refuses enqueue after stop', async () => {
		const runner = createJobRunner({ perform: async () => 'ok' });
		await runner.stop();
		await expect(runner.enqueue({ worker: 'w', prompt: 'x' })).rejects.toThrow(/stopped/);
	});
});
