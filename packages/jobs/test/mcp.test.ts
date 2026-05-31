/**
 * Boundary tests for `mountJobsMcp`. Verifies the wrap-as-MCP-server
 * surface — the underlying runner is tested separately.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createJobRunner, mountJobsMcp } from '../src/index.ts';
import type { JobRunner } from '../src/types.ts';
import type { MockMcpHandle } from '@floe/mock-services';

const teardown: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of teardown) await fn();
	teardown.length = 0;
});

async function freePort(): Promise<number> {
	const { createServer } = await import('node:net');
	return await new Promise<number>((resolve, reject) => {
		const s = createServer();
		s.listen(0, () => {
			const addr = s.address();
			if (addr && typeof addr === 'object') {
				const port = addr.port;
				s.close(() => resolve(port));
			} else {
				s.close();
				reject(new Error('no port'));
			}
		});
		s.on('error', reject);
	});
}

async function setup() {
	const port = await freePort();
	const runner: JobRunner = createJobRunner({ perform: async (j) => `processed: ${j.prompt}` });
	const handle: MockMcpHandle = await mountJobsMcp(runner, { port });
	teardown.push(async () => {
		await handle.stop();
		await runner.stop();
	});
	return { runner, handle, port };
}

describe('mountJobsMcp', () => {
	it('returns a handle with name=jobs and an mcp URL', async () => {
		const { handle, port } = await setup();
		expect(handle.name).toBe('jobs');
		expect(handle.url).toBe(`http://localhost:${port}/mcp`);
	});

	it('non-/mcp paths 404', async () => {
		const { handle } = await setup();
		const r = await fetch(`http://localhost:${handle.port}/anything-else`);
		expect(r.status).toBe(404);
	});
});
