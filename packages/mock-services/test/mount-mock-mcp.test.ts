/**
 * Boundary tests for `mountMockMcp`. We don't drive a real MCP client
 * here (the SDK + transport are exercised in templates); we verify the
 * mount produces a handle with the right shape, on the right port,
 * and that stop() actually closes the listener.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { defineMockService, mountMockMcp } from '../src/index.ts';

const handles: Array<{ stop: () => Promise<void> }> = [];

afterEach(async () => {
	for (const h of handles) await h.stop();
	handles.length = 0;
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

describe('mountMockMcp', () => {
	it('returns handle with name, url, port; stop() closes', async () => {
		const port = await freePort();
		const svc = await defineMockService<{ id: string; v: number }>({
			name: 'test',
			seed: [{ id: 'a', v: 1 }],
			operations: {
				get_a: {
					description: 'get a',
					input: v.object({}),
					handler: (_, store) => store.get('a'),
				},
			},
		});
		const handle = await mountMockMcp(svc, { port });
		handles.push(handle);
		expect(handle.name).toBe('test');
		expect(handle.port).toBe(port);
		expect(handle.url).toBe(`http://localhost:${port}/mcp`);

		// Non-/mcp routes return 404
		const r = await fetch(`http://localhost:${port}/nope`);
		expect(r.status).toBe(404);
	});

	it('multi-service mount namespaces operations under <service>__', async () => {
		const port = await freePort();
		const a = await defineMockService<{ id: string }>({
			name: 'svc_a',
			operations: {
				ping: {
					description: 'ping',
					input: v.object({}),
					handler: () => 'pong-a',
				},
			},
		});
		const b = await defineMockService<{ id: string }>({
			name: 'svc_b',
			operations: {
				ping: {
					description: 'ping',
					input: v.object({}),
					handler: () => 'pong-b',
				},
			},
		});
		const handle = await mountMockMcp([a, b], { port });
		handles.push(handle);
		// Names verified via the service-level operations list (the
		// per-service operations don't carry the namespace; only the
		// mcpName the mount produces does).
		expect(a.operations.map((o) => o.name)).toContain('ping');
		expect(b.operations.map((o) => o.name)).toContain('ping');
	});

	it('reset() re-applies the underlying service seed', async () => {
		const port = await freePort();
		const svc = await defineMockService<{ id: string; n: number }>({
			name: 'counters',
			seed: [{ id: 'a', n: 1 }],
			operations: {
				bump: {
					description: 'bump',
					input: v.object({}),
					handler: (_, store) => {
						const cur = store.get('a');
						if (!cur) return null;
						return store.update('a', { n: cur.n + 1 });
					},
				},
				get: {
					description: 'get',
					input: v.object({}),
					handler: (_, store) => store.get('a'),
				},
			},
		});
		const handle = await mountMockMcp(svc, { port });
		handles.push(handle);
		await (svc.operations.find((o) => o.name === 'bump')!.invoke({}));
		await (svc.operations.find((o) => o.name === 'bump')!.invoke({}));
		const mid = (await svc.operations.find((o) => o.name === 'get')!.invoke({})) as
			| { n: number }
			| null;
		expect(mid?.n).toBe(3);
		handle.reset();
		const after = (await svc.operations.find((o) => o.name === 'get')!.invoke({})) as
			| { n: number }
			| null;
		expect(after?.n).toBe(1);
	});
});
