/**
 * `runServer(assistant, opts?)` — single-call Node HTTP bootstrap for a
 * Floe Assistant.
 *
 * Replaces the 60-90 LOC `server.ts` boilerplate that every example used
 * to carry: `webAdapter` wiring, `serve()` with `requestTimeout: 0`,
 * SIGINT/SIGTERM graceful shutdown, banner logging, optional bench
 * stream-metrics observer, optional openai-compat route mux, optional
 * pre-listen lifecycle (mock MCP servers etc).
 *
 * Sensible defaults for the 6-of-8 trivial case; named options for the
 * non-trivial ones. Use `routes` as a flat path→handler escape hatch
 * for anything truly custom — don't try to bend the API to fit.
 */
import { serve } from '@hono/node-server';
import type { Assistant } from '@floe/runtime';
import { openaiCompat } from '@floe/runtime/openai-compat';
import { webAdapter } from '@floe/adapter-web';
import { wrapWithMetrics } from './metrics.ts';

export interface RunServerOptions {
	/** Port. Defaults to `Number(process.env.PORT) ?? 3000`. */
	port?: number;
	/** Log label in the banner. Defaults to `assistant.config.name`. */
	name?: string;
	/**
	 * Wrap every JSON response with `result.stream` populated from real
	 * `text_delta` observer timings. The bench harness asserts against
	 * this shape; production servers should leave this `false` and emit
	 * to a real observability sink.
	 *
	 * Default: `true` if `process.env.NODE_ENV !== 'production'`,
	 * `false` otherwise.
	 */
	metrics?: boolean;
	/**
	 * Mount OpenAI-compat routes on `/v1/chat/completions`,
	 * `/chat/completions`, `/v1/models`, `/models`, `/v1/embeddings`,
	 * `/embeddings`. When `true`, uses `[assistant]` as the assistants
	 * list. Pass `{ assistants }` to expose multiple.
	 *
	 * Default: `false`.
	 */
	openaiCompat?: boolean | { assistants: Assistant[] };
	/**
	 * Flat path→handler map for arbitrary routes. Matched BEFORE the
	 * Floe fetch (and before openai-compat, when both are enabled).
	 * Use for debug routes, health checks, custom integrations.
	 *
	 * Default: empty.
	 */
	routes?: Record<string, (req: Request) => Response | Promise<Response>>;
	/**
	 * Async pre-listen setup. May return a teardown closure that
	 * `runServer`'s shutdown handler will await before the process
	 * exits. Use for mock MCP servers, seeded databases, warm caches.
	 *
	 * Returning `void` is fine when no teardown is needed.
	 *
	 * Default: none.
	 */
	beforeListen?: () => Promise<(() => Promise<void> | void) | void>;
}

export interface RunServerHandle {
	/** Listening port (resolved from opts.port or env). */
	port: number;
	/** Trigger graceful shutdown: close HTTP, await beforeListen teardown, return. */
	close(): Promise<void>;
}

const OPENAI_COMPAT_ROUTES = new Set([
	'/v1/chat/completions',
	'/chat/completions',
	'/v1/models',
	'/models',
	'/v1/embeddings',
	'/embeddings',
]);

/**
 * Boot the HTTP server with the assistant mounted. Resolves once
 * listening; the returned handle exposes `close()` for graceful shutdown.
 *
 * Always installs SIGINT/SIGTERM handlers that call `close()` and exit.
 */
export async function runServer(
	assistant: Assistant,
	opts: RunServerOptions = {},
): Promise<RunServerHandle> {
	const port = opts.port ?? Number(process.env.PORT ?? 3000);
	const name = opts.name ?? assistant.config.name ?? 'floe';
	const wantMetrics = opts.metrics ?? process.env.NODE_ENV !== 'production';

	// Run pre-listen setup FIRST so mock servers (etc) are up before the
	// Floe Assistant boots — Assistant.boot() may try to reach those MCP
	// servers during initialization.
	let teardown: (() => Promise<void> | void) | null = null;
	if (opts.beforeListen) {
		const result = await opts.beforeListen();
		teardown = typeof result === 'function' ? result : null;
	}

	const floe = webAdapter({ assistant });
	const adapterFetch = async (req: Request): Promise<Response> => floe.fetch(req);
	const baseFetch = wantMetrics ? wrapWithMetrics(adapterFetch) : adapterFetch;

	// openai-compat is a parallel mounter, not a wrapper — the route
	// dispatch decides which handler sees the request.
	const compatAssistants =
		opts.openaiCompat === true
			? [assistant]
			: typeof opts.openaiCompat === 'object' && opts.openaiCompat
				? opts.openaiCompat.assistants
				: null;
	const compatHandler = compatAssistants ? openaiCompat({ assistants: compatAssistants }) : null;

	const customRoutes = opts.routes ?? {};

	const fetch = async (req: Request): Promise<Response> => {
		const path = new URL(req.url).pathname;
		const custom = customRoutes[path];
		if (custom) return await custom(req);
		if (compatHandler && OPENAI_COMPAT_ROUTES.has(path)) return await compatHandler(req);
		return await baseFetch(req);
	};

	const server = serve({
		fetch,
		port,
		// SSE responses can outlive Node's default 300s request timeout.
		serverOptions: { requestTimeout: 0 },
	});

	const closeHttp = (): Promise<void> =>
		new Promise<void>((resolve, reject) => {
			(server as { close: (cb: (err?: Error) => void) => void }).close((err) => {
				if (err) reject(err);
				else resolve();
			});
		});

	let closing = false;
	const close = async (): Promise<void> => {
		if (closing) return;
		closing = true;
		await closeHttp();
		if (teardown) await teardown();
	};

	const onSignal = (signal: NodeJS.Signals): void => {
		void close()
			.catch((err) => {
				console.error(`[${name}] shutdown error on ${signal}:`, err);
			})
			.finally(() => {
				process.exit(0);
			});
	};
	process.once('SIGINT', () => onSignal('SIGINT'));
	process.once('SIGTERM', () => onSignal('SIGTERM'));

	console.log(`[${name}] listening on http://localhost:${port}`);
	if (compatHandler) {
		console.log(`[${name}]   chat UI:    POST /agents/web/<sessionId>`);
		console.log(`[${name}]   openai-compat: POST /v1/chat/completions`);
	}

	return { port, close };
}

export { wrapWithMetrics } from './metrics.ts';
