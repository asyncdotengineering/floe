/**
 * createFloeApp — the library-first entrypoint.
 *
 * Wraps the Floe class + Flue's runtime primitives into a single object
 * that exposes a Web-Standard `fetch(request)` handler. No CLI, no
 * codegen, no `.flue/` directory required.
 *
 * Three shapes:
 *
 *   Shape A — bare Web Standard (Cloudflare Worker, Bun, Deno):
 *     const app = createFloeApp({ ... });
 *     export default { fetch: app.fetch };
 *
 *   Shape B — Node server via @hono/node-server:
 *     const app = createFloeApp({ ... });
 *     serve({ fetch: app.fetch, port: 3000 });
 *
 *   Shape C — mounted in an existing Hono / Express app:
 *     const app = createFloeApp({ ... });
 *     hono.route('/api/chat', app.router);
 *
 * The factory calls `configureFlueRuntime` once at construction time —
 * Flue's runtime is module-scoped, so only one Floe app may exist per
 * process. (Matches Flue's own assumption.)
 */
import {
	configureFlueRuntime,
	createDefaultFlueApp,
	createFlueContext,
	createRunSubscriberRegistry,
	InMemoryRunRegistry,
	InMemoryRunStore,
	InMemorySessionStore,
	resolveModel,
	type AgentHandler,
	type FlueRuntime,
} from '@flue/runtime/internal';
import type { SessionEnv, SessionStore } from '@flue/runtime';
import { Floe } from './floe.ts';
import { registerTaskTracker } from './orchestrator/task-tracker.ts';
import { registerCompactionTracker } from './orchestrator/compaction-tracker.ts';
import type { FloeConfig } from './types.ts';
import type { Role } from '@flue/runtime';
import {
	InMemoryAssistantStateStore,
	type AssistantStateStore,
} from './assistant-state-store.ts';
import { InMemoryTranscriptStore, type TranscriptStore } from './transcript-store.ts';

export interface CreateFloeAppOptions extends FloeConfig {
	/**
	 * Deployment target. 'auto' detects Node vs Cloudflare from globals.
	 * Set explicitly when bundling for environments that look like one
	 * but behave like the other (e.g. Bun reports `process` but acts edge-ish).
	 */
	target?: 'node' | 'cloudflare' | 'auto';
	/** Override the default in-memory session store (pass a Postgres/Redis/KV store here). */
	sessionStore?: SessionStore;
	/**
	 * Durable storage for Floe's per-conversation state (turnCount,
	 * activeFlow, etc.). Defaults to in-memory — fine for
	 * warm-only Node servers and Cloudflare DOs (single-writer per ID);
	 * serverless deployments (Vercel/Lambda) need a durable store like
	 * Turso to survive cold starts.
	 */
	assistantStateStore?: AssistantStateStore;
	/**
	 * Durable storage for the user-renderable conversation transcript
	 * (AI-SDK `UIMessage` shape). When set, three HTTP routes auto-mount:
	 * `GET /history/:sessionId`, `GET /history/user/:userId`,
	 * `DELETE /history/:sessionId`. Defaults to in-memory.
	 */
	transcriptStore?: TranscriptStore;
	/**
	 * Optional bash sandbox factory. Floe agents use their own tool layer
	 * (`defineTool({execute})`) — they DO NOT need this. Only provide it
	 * if your handlers call `ctx.session.env.exec(...)` directly.
	 */
	createDefaultEnv?: () => Promise<SessionEnv>;
	/** Cloudflare-only: forward agent requests to per-agent DOs. */
	routeAgentRequest?: FlueRuntime['routeAgentRequest'];
}

/**
 * Minimal structural type for the returned router. Matches Hono's surface
 * without requiring `hono` as a direct dependency — users who want to mount
 * Floe inside their own Hono app can cast: `app.route('/api', floe.router as Hono)`.
 */
export interface FloeRouter {
	fetch: (req: Request, ...rest: unknown[]) => Response | Promise<Response>;
	route(path: string, router: unknown): unknown;
}

export interface FloeApp {
	/** Web-Standard handler: `(req, env?, ctx?) => Response`. */
	fetch: (req: Request, ...rest: unknown[]) => Response | Promise<Response>;
	/** The underlying Hono router — mount in an existing app. */
	router: FloeRouter;
	/** Underlying Floe instance — for `explainTriage(...)` and friends. */
	floe: Floe;
}

const RUNTIME_VERSION = '0.7.0';

export function createFloeApp(opts: CreateFloeAppOptions): FloeApp {
	const target = resolveTarget(opts.target);
	const assistantStateStore =
		opts.assistantStateStore ?? new InMemoryAssistantStateStore();
	const transcriptStore = opts.transcriptStore ?? new InMemoryTranscriptStore();
	const floe = new Floe({
		assistants: opts.assistants,
		channels: opts.channels,
		defaults: opts.defaults,
		assistantStateStore,
		transcriptStore,
	});

	const channelNames = Object.keys(opts.channels);
	if (channelNames.length === 0) {
		throw new Error('[floe] createFloeApp: no channels registered.');
	}

	const handlers: Record<string, AgentHandler> = {};
	for (const name of channelNames) {
		handlers[name] = floe.handler({ channel: name }) as AgentHandler;
	}

	const sessionStore = opts.sessionStore ?? new InMemorySessionStore();
	const runStore = new InMemoryRunStore();
	const runRegistry = new InMemoryRunRegistry();
	const runSubscribers = createRunSubscriberRegistry();
	const createDefaultEnv = opts.createDefaultEnv ?? createNoBashEnvFactory();
	const isLocalMode =
		typeof process !== 'undefined' && process.env?.FLUE_MODE === 'local';

	// Subscribe once to Flue's event stream so per-run task delegation +
	// compaction events roll up into TurnMetrics. Both are idempotent
	// across multiple createFloeApp calls (only one Floe app per process
	// is supported).
	registerTaskTracker();
	registerCompactionTracker();

	// v1 BLUEPRINT wiring: union roles across all conversations and pass
	// to Flue's agentConfig. The LLM sees them via Flue's auto-injected
	// `task` tool registry. Name collisions across conversations with
	// non-identical role definitions are a configuration bug — throw.
	// See docs/BLUEPRINT.md §3 (Role primitive) + §4 (modes).
	const allRoles: Record<string, Role> = {};
	for (const convo of Object.values(opts.assistants)) {
		if (!convo.roles) continue;
		for (const [name, role] of Object.entries(convo.roles)) {
			const existing = allRoles[name];
			if (existing && existing !== role) {
				throw new Error(
					`[floe] Role "${name}" defined in multiple conversations with different shapes. ` +
						`Either share the same Role object or pick a unique name per conversation.`,
				);
			}
			allRoles[name] = role;
		}
	}

	configureFlueRuntime({
		target,
		runtimeVersion: RUNTIME_VERSION,
		manifest: {
			agents: channelNames.map((name) => ({ name, triggers: { webhook: true } })),
		},
		webhookAgents: channelNames,
		allowNonWebhook: isLocalMode,
		handlers,
		createContext: (id, runId, payload, req) =>
			createFlueContext({
				id,
				runId,
				payload,
				env: typeof process !== 'undefined' ? (process.env as Record<string, string>) : {},
				req,
				agentConfig: {
					systemPrompt: '',
					skills: {},
					roles: allRoles,
					model: undefined,
					resolveModel,
				},
				createDefaultEnv,
				defaultStore: sessionStore,
			}),
		runStore,
		runRegistry,
		runSubscribers,
		routeAgentRequest: opts.routeAgentRequest,
	});

	const app = createDefaultFlueApp();
	const fetch = withHistoryRoutes(
		app.fetch as (req: Request, ...rest: unknown[]) => Response | Promise<Response>,
		transcriptStore,
	);
	return {
		fetch,
		router: app as unknown as FloeRouter,
		floe,
	};
}

/**
 * Wraps the inner Hono fetch with three transcript-history routes
 * matched BEFORE any Flue dispatch:
 *   GET    /history/:sessionId
 *   GET    /history/user/:userId
 *   DELETE /history/:sessionId
 *
 * Implemented at the fetch layer (not Hono `.route()`) so we don't need
 * `hono` as a direct dep. The path matcher is intentionally minimal —
 * we own these exact paths and nothing else.
 */
function withHistoryRoutes(
	innerFetch: (req: Request, ...rest: unknown[]) => Response | Promise<Response>,
	store: TranscriptStore,
): (req: Request, ...rest: unknown[]) => Response | Promise<Response> {
	return async (req: Request, ...rest: unknown[]) => {
		const url = new URL(req.url);
		const p = url.pathname;

		// GET /history/user/:userId
		const userMatch = /^\/history\/user\/([^/?]+)\/?$/.exec(p);
		if (userMatch && req.method === 'GET') {
			const userId = decodeURIComponent(userMatch[1]!);
			const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10) || 50;
			const result = await store.listSessions(userId, { limit });
			return jsonResponse(result);
		}

		// GET /history/:sessionId  and  DELETE /history/:sessionId
		const sessionMatch = /^\/history\/([^/?]+)\/?$/.exec(p);
		if (sessionMatch) {
			const sessionId = decodeURIComponent(sessionMatch[1]!);
			if (req.method === 'GET') {
				const limit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10) || 100;
				const cursor = url.searchParams.get('cursor') ?? undefined;
				const result = await store.list(sessionId, {
					limit,
					...(cursor ? { cursor } : {}),
				});
				return jsonResponse(result);
			}
			if (req.method === 'DELETE') {
				await store.delete(sessionId);
				return new Response(null, { status: 204 });
			}
		}

		return innerFetch(req, ...rest);
	};
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

function resolveTarget(t: CreateFloeAppOptions['target']): 'node' | 'cloudflare' {
	if (t && t !== 'auto') return t;
	// process.versions.node distinguishes Node from CF Workers / Bun-edge.
	if (typeof process !== 'undefined' && process.versions?.node) return 'node';
	return 'cloudflare';
}

/**
 * Returns a factory that produces a SessionEnv which throws on access.
 * Floe agents never call `ctx.session.env.exec` — they route tool calls
 * through Floe's own orchestrator. If a tool accidentally reaches for
 * bash, the error message points the user at the right opt-in.
 */
/**
 * A benign empty SessionEnv used when no sandbox is configured.
 *
 * Flue's `discoverSessionContext` runs at session creation and reads
 * `env.cwd` + `env.readdir(cwd)` + `env.exists(AGENTS.md)` regardless
 * of whether the assistant actually uses bash. A throw-on-access proxy
 * (the previous design) breaks this path even for LLM-only assistants
 * that genuinely don't need a sandbox. A benign env returns:
 *   - `cwd: '/'` — placeholder; Flue's discovery composes the prompt
 *     with this and Floe's `floePrompt` overwrites the result anyway.
 *   - `exists()`/`readFile()` — return "not found" / throw ENOENT-like
 *     so AGENTS.md discovery resolves to empty cleanly.
 *   - `exec()` — explicit throw with a clear message. THIS is the
 *     guardrail for tools that genuinely need bash without a sandbox.
 *   - other filesystem methods — same throw-on-call as exec, since
 *     they're host-side I/O the user explicitly opted out of.
 *
 * Net effect: discovery + observability paths work; actual bash / I/O
 * still throws loudly with a direct error message.
 */
function createNoBashEnvFactory(): () => Promise<SessionEnv> {
	return () => Promise.resolve(makeNoBashSessionEnv());
}

function makeNoBashSessionEnv(): SessionEnv {
	const noSandbox = (op: string): never => {
		throw new Error(
			`[floe] No bash sandbox configured (tried to call session.env.${op}). ` +
				'Pass `createDefaultEnv` to createFloeApp() (or `sandbox: localSandbox()` on ' +
				'the Assistant) if your tools need shell / filesystem access.',
		);
	};
	const enoent = async (path: string): Promise<never> => {
		const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, ${path}`);
		err.code = 'ENOENT';
		throw err;
	};
	return {
		// Discovery-friendly defaults — Flue's discoverSessionContext reads
		// these at every session init. Returning sensible empties lets
		// initialization complete; Floe's `floePrompt` overrides the
		// resulting systemPrompt anyway.
		cwd: '/',
		directoryListing: [],
		exists: async () => false,
		readFile: (path: string) => enoent(path),
		readFileBuffer: (path: string) => enoent(path),
		readdir: async () => [],
		resolvePath: (p: string) => p,
		// Real side-effect operations — throw with a clear message. These
		// only fire if a tool genuinely tries to use bash/fs without a
		// sandbox configured.
		exec: () => noSandbox('exec') as never,
		writeFile: () => noSandbox('writeFile') as never,
		stat: () => noSandbox('stat') as never,
		mkdir: () => noSandbox('mkdir') as never,
		rm: () => noSandbox('rm') as never,
	} as unknown as SessionEnv;
}
