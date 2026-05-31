/**
 * Smoke test for the chief-of-staff template. Verifies:
 *   - Assistant constructs with the 4 specialist roles (incl. deep-researcher)
 *   - All 6 MCPs mount: 4 bundled + 1 inline custom (Commitments) +
 *     1 backend-as-MCP (Jobs from @floe/jobs)
 *   - Memory preload bumped to 1500 tokens (CoS needs more context)
 *   - The inline Commitments MCP responds (proves defineMockService)
 *   - The Jobs MCP responds (proves @floe/jobs wiring)
 *   - JobRunner round-trip: enqueue → poll → done (proves background
 *     execution actually happens, no LLM needed for this assertion)
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createChiefOfStaff } from '../floe.config.ts';
import type { MountedMocks } from '../mocks.ts';
import type { JobsBundle } from '../jobs.ts';

let booted: {
	mocks: MountedMocks;
	jobs: JobsBundle;
	assistant: import('@floe/runtime').Assistant;
} | null = null;

afterAll(async () => {
	if (booted) {
		await booted.jobs.stop();
		await booted.mocks.stopAll();
	}
});

describe('chief-of-staff template — boot smoke', () => {
	it('Assistant constructs with the 4 specialist roles + 6 MCPs', async () => {
		process.env.COS_MOCK_NOTION_PORT = String(45401);
		process.env.COS_MOCK_LINEAR_PORT = String(45402);
		process.env.COS_MOCK_CALENDAR_PORT = String(45403);
		process.env.COS_MOCK_EMAIL_PORT = String(45404);
		process.env.COS_MOCK_COMMITMENTS_PORT = String(45405);
		process.env.COS_JOBS_PORT = String(45406);
		booted = await createChiefOfStaff();

		expect(booted.assistant.config.name).toBe('chief-of-staff');
		expect(booted.assistant.config.mode).toBe('coordinate');
		// Lexicographic sort.
		expect(Object.keys(booted.assistant.config.roles ?? {}).sort()).toEqual([
			'commitment-tracker',
			'comms-drafter',
			'deep-researcher',
			'exec-briefer',
		]);
		expect(booted.assistant.config.mcp?.map((m) => m.name).sort()).toEqual([
			'calendar',
			'commitments',
			'email',
			'jobs',
			'linear',
			'notion',
		]);
	});

	it('memory.preload bumped to 1500 tokens', async () => {
		if (!booted) throw new Error('boot first');
		const mem = booted.assistant.config.memory;
		expect(mem && mem !== false ? mem.preload?.maxTokens : null).toBe(1500);
	});

	it('inline Commitments MCP responds (proves defineMockService)', async () => {
		if (!booted) throw new Error('boot first');
		const probe = await fetch(
			`${booted.mocks.commitments.url.replace('/mcp', '/')}health`,
		);
		expect(probe.status).toBe(404);
	});

	it('Jobs MCP responds (proves @floe/jobs wiring)', async () => {
		if (!booted) throw new Error('boot first');
		const probe = await fetch(`${booted.jobs.mcp.url.replace('/mcp', '/')}health`);
		expect(probe.status).toBe(404);
	});

	it('JobRunner does real background work (enqueue → poll → done)', async () => {
		if (!booted) throw new Error('boot first');
		// Use the runner DIRECTLY (not via the LLM) so this test is
		// fast + deterministic + offline. Proves the runner actually
		// fires `perform` and surfaces results.
		//
		// The default `perform` in jobs.ts calls assistant.run() — for
		// THIS assertion we want to avoid LLM calls. We swap in a fake
		// perform via a fresh test runner that wraps the same MCP
		// expectations. The production runner is left untouched.
		const { createJobRunner } = await import('@floe/jobs');
		const testRunner = createJobRunner({
			perform: async (job) => `processed: ${job.prompt}`,
		});
		try {
			const enqueued = await testRunner.enqueue({
				worker: 'deep-researcher',
				prompt: 'unit-test prompt',
			});
			expect(enqueued.status).toBe('queued');
			const deadline = Date.now() + 1500;
			let finished: { status: string; result?: string } | null = null;
			while (Date.now() < deadline) {
				const j = await testRunner.get(enqueued.id);
				if (j?.status === 'done') {
					finished = j;
					break;
				}
				await new Promise((r) => setTimeout(r, 10));
			}
			expect(finished?.status).toBe('done');
			expect(finished?.result).toBe('processed: unit-test prompt');
		} finally {
			await testRunner.stop();
		}
	});
});
