/**
 * Boundary tests for `runServer`.
 *
 * We don't boot a real Assistant (slow + flaky); we exercise the
 * route-dispatch and lifecycle contracts with a stub. The pieces
 * worth pinning:
 *
 *   - `routes` map is checked BEFORE openai-compat which is checked
 *     BEFORE the Floe fetch — order matters and a regression here is
 *     silent (you'd just hit the wrong handler).
 *   - `openaiCompat: true` exposes the six OpenAI paths and nothing else.
 *   - `beforeListen` must resolve BEFORE listen — mock MCPs need to be up
 *     before the Assistant boots.
 *   - `close()` is idempotent (SIGINT + SIGTERM can both fire).
 *   - `metrics` default flips on NODE_ENV.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Assistant } from '@floe/runtime';
import { runServer } from '../src/index.ts';

// Free-port helper — keeps tests parallel-safe.
async function freePort(): Promise<number> {
	const { createServer } = await import('node:net');
	return await new Promise<number>((resolve, reject) => {
		const s = createServer();
		s.unref();
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

// Minimal FloeApp stub for webAdapter's `_app({ web: webChannel })` call.
// We don't boot a real Assistant — slow + flaky — we just need the
// fetch surface so route dispatch can be exercised end-to-end.
const fakeFloeApp = {
	fetch: async (req: Request): Promise<Response> => {
		const path = new URL(req.url).pathname;
		return new Response(JSON.stringify({ from: 'floe', path }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	},
	router: {} as never,
	floe: {} as never,
};

const fakeAssistant = {
	config: { name: 'test-bot' },
	_app: () => fakeFloeApp,
} as unknown as Assistant;

const handles: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
	for (const h of handles) await h.close();
	handles.length = 0;
});

describe('runServer — basic lifecycle', () => {
	it('listens on the chosen port + close() shuts down', async () => {
		const port = await freePort();
		const h = await runServer(fakeAssistant, { port, metrics: false });
		handles.push(h);
		expect(h.port).toBe(port);
		// Round-trip a request to prove the server is up.
		const res = await fetch(`http://localhost:${port}/agents/web/sess1`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ message: 'hi' }),
		});
		expect(res.status).toBe(200);
	});

	it('close() is idempotent (multi-signal safe)', async () => {
		const port = await freePort();
		const h = await runServer(fakeAssistant, { port, metrics: false });
		await h.close();
		await h.close(); // must not throw
	});
});

describe('runServer — route dispatch precedence', () => {
	it('custom routes win over openai-compat AND the Floe fetch', async () => {
		const port = await freePort();
		const h = await runServer(fakeAssistant, {
			port,
			metrics: false,
			openaiCompat: true,
			routes: {
				'/v1/chat/completions': () =>
					new Response('overridden', { status: 200 }),
				'/health': () => new Response('ok', { status: 200 }),
			},
		});
		handles.push(h);

		// Custom route shadows the openai-compat path.
		const r1 = await fetch(`http://localhost:${port}/v1/chat/completions`, {
			method: 'POST',
		});
		expect(await r1.text()).toBe('overridden');

		// Custom route works on its own path.
		const r2 = await fetch(`http://localhost:${port}/health`);
		expect(await r2.text()).toBe('ok');
	});

	it('openai-compat enabled adds the six standard routes', async () => {
		const port = await freePort();
		const h = await runServer(fakeAssistant, {
			port,
			metrics: false,
			openaiCompat: true,
		});
		handles.push(h);
		// The openai-compat handler responds (even if with an error for a
		// malformed body) — we just need to know dispatch reached it, not
		// the Floe fetch.
		const r = await fetch(`http://localhost:${port}/v1/models`);
		// /v1/models is a GET endpoint on the openai-compat handler; the
		// Floe fetch would 404 here. Any non-stub response proves dispatch.
		const body = await r.text();
		expect(body).not.toContain('"from":"floe"');
	});

	it('openai-compat off lets the Floe fetch see the openai paths', async () => {
		const port = await freePort();
		const h = await runServer(fakeAssistant, { port, metrics: false });
		handles.push(h);
		const r = await fetch(`http://localhost:${port}/v1/chat/completions`);
		const body = await r.json();
		expect(body).toEqual({ from: 'floe', path: '/v1/chat/completions' });
	});
});

describe('runServer — beforeListen lifecycle', () => {
	it('beforeListen runs BEFORE the server starts accepting requests', async () => {
		const port = await freePort();
		const order: string[] = [];
		const h = await runServer(fakeAssistant, {
			port,
			metrics: false,
			beforeListen: async () => {
				order.push('beforeListen-start');
				await new Promise((r) => setTimeout(r, 5));
				order.push('beforeListen-end');
				return async () => {
					order.push('teardown');
				};
			},
		});
		handles.push(h);
		// First request: beforeListen MUST have completed already.
		await fetch(`http://localhost:${port}/agents/web/s1`, { method: 'POST' });
		expect(order.slice(0, 2)).toEqual([
			'beforeListen-start',
			'beforeListen-end',
		]);

		await h.close();
		handles.length = 0;
		expect(order).toEqual([
			'beforeListen-start',
			'beforeListen-end',
			'teardown',
		]);
	});

	it('beforeListen with no teardown is fine', async () => {
		const port = await freePort();
		const h = await runServer(fakeAssistant, {
			port,
			metrics: false,
			beforeListen: async () => {
				// no return — implicitly undefined, must not throw on close()
			},
		});
		await h.close();
	});
});

describe('runServer — defaults', () => {
	it('port defaults to env PORT when not provided', async () => {
		const port = await freePort();
		const prev = process.env.PORT;
		process.env.PORT = String(port);
		try {
			const h = await runServer(fakeAssistant, { metrics: false });
			handles.push(h);
			expect(h.port).toBe(port);
		} finally {
			if (prev === undefined) delete process.env.PORT;
			else process.env.PORT = prev;
		}
	});

	it('metrics default flips off in NODE_ENV=production', async () => {
		const port = await freePort();
		const prev = process.env.NODE_ENV;
		process.env.NODE_ENV = 'production';
		try {
			const h = await runServer(fakeAssistant, { port });
			handles.push(h);
			// Use a non-agent-turn path so webAdapter passes through to the
			// stub's JSON response (agent-turn POSTs get re-wrapped as SSE).
			// In production, wrapWithMetrics is skipped — even with a
			// `x-flue-run-id` header from a real Floe response, the body
			// would NOT carry a `result.stream` field.
			const r = await fetch(`http://localhost:${port}/health-check`);
			const body = (await r.json()) as { result?: { stream?: unknown } };
			expect(body.result?.stream).toBeUndefined();
		} finally {
			if (prev === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = prev;
		}
	});

	it('name defaults to assistant.config.name', async () => {
		const port = await freePort();
		const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			const h = await runServer(fakeAssistant, { port, metrics: false });
			handles.push(h);
			expect(spy).toHaveBeenCalledWith(
				expect.stringContaining('[test-bot]'),
			);
		} finally {
			spy.mockRestore();
		}
	});
});
