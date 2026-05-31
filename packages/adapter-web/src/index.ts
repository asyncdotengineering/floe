/**
 * @floe/adapter-web — Web (HTTP) adapter for @floe/runtime.
 *
 * Mounts a Floe assistant on a Web-Standard `fetch` surface. The wire is
 * **OpenAI Chat Completions chunked SSE** by default — the same wire
 * every voice platform (Vapi, ElevenLabs, LiveKit) and every OpenAI SDK
 * client speaks. There is no separate "voice mode" or "chat mode"; one
 * canonical wire serves both. See `docs/LATENCY.md` for the rationale.
 *
 * Content negotiation:
 *   - `Accept: text/event-stream`     → OpenAI SSE (default for unspecified)
 *   - `Accept: application/json`      → buffered `chat.completion` JSON
 *
 * Dev-only opt-in:
 *   - `X-Floe-Debug-Events: 1`        → adds one `event: floe.run` SSE
 *                                       event with `{events, state}` for
 *                                       bench / dev tooling. Never set
 *                                       this in production traffic.
 *
 * Usage:
 *
 *   import { Hono } from 'hono';
 *   import { webAdapter } from '@floe/adapter-web';
 *   import { ops } from './assistant.ts';
 *
 *   const app = new Hono();
 *   app.route('/', webAdapter({ assistant: ops }));
 *   export default app;
 *
 * Or, without Hono (Node / Cloudflare / Bun):
 *
 *   serve({ fetch: webAdapter({ assistant: ops }).fetch });
 */
import type { Assistant } from '@floe/runtime';
import {
	webChannel,
	streamAsOpenAISSE,
	bufferAsOpenAIJson,
	newCompletionId,
	callerWantsBufferedJson,
	callerWantsDebugRunEvent,
	type OpenAIChunkContext,
} from '@floe/runtime/internal';

export interface WebAdapterOptions {
	assistant: Assistant;
}

export interface WebAdapter {
	/** Web-Standard fetch handler. Mount on Node, Cloudflare, Vercel, Hono. */
	fetch: (req: Request, ...rest: unknown[]) => Response | Promise<Response>;
	/** Hono-style router mountability. */
	route(path: string, router: unknown): unknown;
}

/**
 * The agent-turn POST URL pattern owned by the inner Flue dispatcher.
 * Anything that doesn't match this passes through to the inner app
 * unchanged (history reads, errors, non-POST methods).
 */
const AGENT_POST_RE = /^\/agents\/[^/]+\/[^/]+\/?$/;

function isAgentTurnPost(req: Request): boolean {
	if (req.method !== 'POST') return false;
	const path = new URL(req.url).pathname;
	return AGENT_POST_RE.test(path);
}

/**
 * Rewrite the inbound request to ask the inner Flue dispatcher for its
 * native event-stream response. The mux then translates each Flue event
 * into an OpenAI chunk before it reaches the client. Without this
 * rewrite, Flue would hand us a buffered JSON envelope and we'd lose
 * per-token streaming.
 */
function asInternalSSERequest(req: Request): Request {
	const headers = new Headers(req.headers);
	headers.set('accept', 'text/event-stream');
	const init: RequestInit & { duplex?: 'half' } = {
		method: req.method,
		headers,
		body: req.body,
		redirect: req.redirect,
		signal: req.signal,
	};
	if (req.body) init.duplex = 'half';
	return new Request(req.url, init);
}

export function webAdapter(opts: WebAdapterOptions): WebAdapter {
	const app = opts.assistant._app({ web: webChannel });
	const inner = app.fetch;
	return {
		fetch: async (req: Request, ...rest: unknown[]) => {
			// Anything that isn't an agent turn (history reads, OpenAI-compat
			// routes mounted alongside, errors, OPTIONS) passes through
			// unchanged. The mux only owns the agent-turn wire.
			if (!isAgentTurnPost(req)) {
				return inner(req, ...rest);
			}

			// Drive the inner Flue dispatcher in streaming mode regardless
			// of what the caller's Accept said. We'll re-shape the response
			// at the wire — the upstream stream is just internal plumbing.
			const upstream = await inner(asInternalSSERequest(req), ...rest);

			// Pass through non-2xx upstreams as-is so the client sees the
			// actual error envelope (not a torn SSE stream).
			if (!upstream.ok) return upstream;

			const ctx: OpenAIChunkContext = {
				id: newCompletionId(),
				created: Math.floor(Date.now() / 1000),
				model: opts.assistant.config.model ?? 'floe/unknown',
			};

			// Content negotiation: caller wants the legacy buffered JSON →
			// run the same mux to completion, aggregate, and respond.
			// Otherwise: stream OpenAI SSE.
			const citations = opts.assistant.config.citations ?? 'off';
			// Only coordinate-mode-with-flows assistants need the
			// host-text buffer (see MuxOptions.bufferHostText).
			const bufferHostText =
				opts.assistant.config.mode === 'coordinate' &&
				(opts.assistant.config.flows?.length ?? 0) > 0;
			if (callerWantsBufferedJson(req)) {
				return bufferAsOpenAIJson(upstream, ctx, citations, bufferHostText);
			}
			return streamAsOpenAISSE(upstream, {
				ctx,
				includeDebugRunEvent: callerWantsDebugRunEvent(req),
				citations,
				bufferHostText,
			});
		},
		route: (path, router) => app.router.route(path, router),
	};
}
