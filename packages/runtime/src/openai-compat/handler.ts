/**
 * OpenAI-compatible HTTP handler.
 *
 * Speaks `POST /v1/chat/completions`, `GET /v1/models`,
 * `POST /v1/embeddings` — the same wire format the OpenAI SDK, AI SDK,
 * LangChain, LlamaIndex, Cursor, OpenWebUI, Vapi, ElevenLabs, LiveKit
 * etc. all speak. Mount one Assistant, every consumer Just Works.
 *
 * Streaming: when `"stream": true` (or omitted — voice platforms default
 * to streaming), each LLM token reaches the client as it lands, via the
 * canonical mux at `../streaming/`. This is the SAME mux `webAdapter`
 * uses; there is no second streaming code path. See `docs/LATENCY.md`.
 *
 * Model mapping (the `model` field on incoming requests):
 *   - `floe/<name>`              → the assistant named <name>
 *   - `<name>`                   → bare assistant name shortcut
 *   - `auto` / `floe/auto`       → the registered assistant
 *
 * Any other value falls through to the configured assistant — Floe only
 * routes to its own registered assistants regardless of model field.
 *
 * Auth: pass an `authorize(req)` callback to gate on
 * `Authorization: Bearer …`. Returning false → 401.
 *
 * Client-provided `tools` are **rejected** — tools are registered at
 * Assistant-init time for security and DX clarity. Pass `tool_choice:
 * "none"` to suppress and ignore. Function-call results come back on the
 * stream as normal OpenAI `tool_calls` deltas.
 */
import type { Assistant } from '../assistant.ts';
import type { Embedder } from '../embedders/types.ts';
import {
	streamAsOpenAISSE,
	bufferAsOpenAIJson,
	newCompletionId,
	callerWantsDebugRunEvent,
	type OpenAIChunkContext,
} from '../streaming/index.ts';
import { webChannel } from '../web-channel.ts';
import type {
	OpenAIChatCompletionRequest,
	OpenAIEmbeddingRequest,
	OpenAIEmbeddingResponse,
	OpenAIErrorResponse,
	OpenAIModel,
	OpenAIModelList,
} from './types.ts';

export interface OpenAICompatOptions {
	/**
	 * The Assistants to serve. The `model` field on incoming requests
	 * selects which one runs (`floe/<name>` or bare `<name>`). When the
	 * model field is `auto`, `floe/auto`, or doesn't match any assistant
	 * by name, the FIRST assistant in this array is used.
	 *
	 * Pass `[oneAssistant]` for the trivial single-assistant case.
	 */
	assistants: Assistant[];
	/**
	 * Optional embedder for `POST /v1/embeddings`. Skip to disable that
	 * route (returns 404). Recommended: wire the same embedder you use
	 * for memory / hybrid knowledge.
	 */
	embedder?: Embedder;
	/**
	 * Auth gate. Return true to allow, false to reject with 401. Optional
	 * — if omitted, the handler accepts any request.
	 */
	authorize?: (req: Request) => boolean | Promise<boolean>;
	/** Owner string surfaced in `/v1/models` responses. Default 'floe'. */
	ownedBy?: string;
}

export type OpenAIHandler = (req: Request) => Promise<Response>;

const JSON_HEADERS: Record<string, string> = {
	'content-type': 'application/json',
};

export function openaiCompat(opts: OpenAICompatOptions): OpenAIHandler {
	if (!Array.isArray(opts.assistants) || opts.assistants.length === 0) {
		throw new Error('[openaiCompat] `assistants` must be a non-empty Assistant[]');
	}
	const ownedBy = opts.ownedBy ?? 'floe';
	// Bootstrap each Assistant's FloeApp once and index by name. This is
	// the same lazy-cached app `webAdapter` mounts — both adapters share
	// the underlying inner dispatcher per Assistant.
	const apps = new Map<string, { assistant: Assistant; fetch: (req: Request, ...rest: unknown[]) => Response | Promise<Response> }>();
	for (const assistant of opts.assistants) {
		if (apps.has(assistant.name)) {
			throw new Error(`[openaiCompat] duplicate assistant name "${assistant.name}"`);
		}
		const app = assistant._app({ web: webChannel });
		apps.set(assistant.name, { assistant, fetch: app.fetch });
	}
	const defaultAssistantName = opts.assistants[0]!.name;

	return async (req: Request): Promise<Response> => {
		if (opts.authorize) {
			const ok = await opts.authorize(req);
			if (!ok) return errorResponse(401, 'Unauthorized', 'invalid_request_error');
		}
		const url = new URL(req.url);
		const path = url.pathname.replace(/\/+$/, '');

		if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
			return jsonResponse(buildModels(opts.assistants, ownedBy));
		}

		if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
			return handleChatCompletion(req, opts, apps, defaultAssistantName);
		}

		if (req.method === 'POST' && (path === '/v1/embeddings' || path === '/embeddings')) {
			if (!opts.embedder) {
				return errorResponse(404, 'No embedder configured on this Floe deployment.', 'no_embedder');
			}
			return handleEmbeddings(req, opts.embedder);
		}

		return errorResponse(404, `Unknown route ${req.method} ${path}`, 'unknown_route');
	};
}

// ─── Route: /v1/models ────────────────────────────────────────────────────

function buildModels(assistants: Assistant[], ownedBy: string): OpenAIModelList {
	const created = Math.floor(Date.now() / 1000);
	const data: OpenAIModel[] = assistants.map((a) => ({
		id: `floe/${a.name}`,
		object: 'model',
		created,
		owned_by: ownedBy,
		floe: { conversation: a.name },
	}));
	return { object: 'list', data };
}

// ─── Route: /v1/chat/completions ──────────────────────────────────────────

async function handleChatCompletion(
	req: Request,
	opts: OpenAICompatOptions,
	apps: Map<string, { assistant: Assistant; fetch: (req: Request, ...rest: unknown[]) => Response | Promise<Response> }>,
	defaultAssistantName: string,
): Promise<Response> {
	let body: OpenAIChatCompletionRequest;
	try {
		body = (await req.json()) as OpenAIChatCompletionRequest;
	} catch {
		return errorResponse(400, 'Invalid JSON body', 'invalid_request_error');
	}
	if (!Array.isArray(body.messages) || body.messages.length === 0) {
		return errorResponse(400, '`messages` is required and must be a non-empty array', 'invalid_request_error');
	}
	if (body.tools && body.tools.length > 0 && body.tool_choice !== 'none') {
		return errorResponse(
			400,
			'Floe does not accept client-provided tools. Tools are registered at Assistant init time. Pass `tool_choice: "none"` to suppress this error, or remove `tools`.',
			'unsupported_parameter',
		);
	}

	const lastUser = lastUserMessage(body.messages);
	if (!lastUser) {
		return errorResponse(400, '`messages` must contain at least one user message', 'invalid_request_error');
	}

	// Resolve the target Assistant from the `model` field.
	const assistantName = resolveAssistantName(body.model, defaultAssistantName, apps);
	const app = apps.get(assistantName);
	if (!app) {
		const available = [...apps.keys()].map((n) => `floe/${n}`).join(', ');
		return errorResponse(
			404,
			`Model "${body.model}" not found. Available: ${available}`,
			'model_not_found',
		);
	}

	const sessionId = deriveSessionId(body);

	// Translate the OpenAI request into the inner Flue webhook shape and
	// POST it to ourselves via the FloeApp's fetch surface. The inner
	// dispatcher runs the turn and emits Flue's native event stream over
	// SSE; the mux re-shapes it into OpenAI chunks.
	const internalUrl = new URL(req.url);
	internalUrl.pathname = `/agents/web/${encodeURIComponent(sessionId)}`;
	internalUrl.search = '';
	const internalBody = JSON.stringify({
		message: lastUser,
		assistantName,
		metadata: {
			...(body.metadata ?? {}),
			...(body.user ? { userId: body.user } : {}),
		},
	});
	const internalHeaders = new Headers();
	internalHeaders.set('content-type', 'application/json');
	internalHeaders.set('accept', 'text/event-stream');
	const internalReq = new Request(internalUrl, {
		method: 'POST',
		headers: internalHeaders,
		body: internalBody,
		signal: req.signal,
	});

	const upstream = await app.fetch(internalReq);
	if (!upstream.ok) return upstream;

	const ctx: OpenAIChunkContext = {
		id: newCompletionId(),
		created: Math.floor(Date.now() / 1000),
		// Echo whatever the caller asked for. Per OpenAI's spec, the
		// response's `model` field is the model that ran — we report what
		// the caller addressed us as.
		model: body.model || `floe/${assistantName}`,
	};

	// `stream: false` (or unset, in the OpenAI sense — the field
	// determines wire format, not whether we run streaming internally).
	// We always run the inner pipeline in SSE mode; buffering happens at
	// the wire only.
	const citations = app.assistant.config.citations ?? 'off';
	const bufferHostText =
		app.assistant.config.mode === 'coordinate' &&
		(app.assistant.config.flows?.length ?? 0) > 0;
	if (body.stream === false) {
		return bufferAsOpenAIJson(upstream, ctx, citations, bufferHostText);
	}
	return streamAsOpenAISSE(upstream, {
		ctx,
		includeDebugRunEvent: callerWantsDebugRunEvent(req),
		citations,
		bufferHostText,
	});
}

// ─── Route: /v1/embeddings ────────────────────────────────────────────────

async function handleEmbeddings(req: Request, embedder: Embedder): Promise<Response> {
	let body: OpenAIEmbeddingRequest;
	try {
		body = (await req.json()) as OpenAIEmbeddingRequest;
	} catch {
		return errorResponse(400, 'Invalid JSON body', 'invalid_request_error');
	}
	if (!body.input) {
		return errorResponse(400, '`input` is required', 'invalid_request_error');
	}
	const inputs = Array.isArray(body.input) ? body.input : [body.input];
	const embeddings = await embedder.embed(inputs);
	const totalChars = inputs.reduce((acc, s) => acc + s.length, 0);
	const promptTokens = Math.ceil(totalChars / 4);
	const response: OpenAIEmbeddingResponse = {
		object: 'list',
		data: embeddings.map((embedding, i) => ({ object: 'embedding', embedding, index: i })),
		model: embedder.model,
		usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
	};
	return jsonResponse(response);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function resolveAssistantName(
	model: string,
	defaultName: string,
	apps: Map<string, unknown>,
): string {
	if (!model || model === 'auto' || model === 'floe/auto') return defaultName;
	const stripped = model.startsWith('floe/') ? model.slice('floe/'.length) : model;
	// Drop any `@agent` suffix — legacy openai-compat concept; Floe v1
	// has no per-agent pin via the model field.
	const [name] = stripped.split('@');
	const candidate = name ?? defaultName;
	return apps.has(candidate) ? candidate : defaultName;
}

function lastUserMessage(messages: OpenAIChatCompletionRequest['messages']): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role === 'user' && typeof m.content === 'string') return m.content;
	}
	return null;
}

function deriveSessionId(body: OpenAIChatCompletionRequest): string {
	// Stable per-conversation session id, so Flue can rebuild the session
	// across the SAME OpenAI client's repeated requests.
	if (body.metadata && typeof body.metadata['sessionId'] === 'string') {
		return body.metadata['sessionId'] as string;
	}
	if (body.user) return `oai:${body.user}`;
	const firstUser = body.messages.find((m) => m.role === 'user');
	if (firstUser && typeof firstUser.content === 'string') {
		let h = 0;
		for (let i = 0; i < firstUser.content.length; i++) {
			h = (h * 31 + firstUser.content.charCodeAt(i)) >>> 0;
		}
		return `oai:anon:${h.toString(36)}`;
	}
	return `oai:ephemeral:${Math.random().toString(36).slice(2, 10)}`;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function errorResponse(status: number, message: string, code: string): Response {
	const body: OpenAIErrorResponse = {
		error: {
			message,
			type: 'invalid_request_error',
			code,
		},
	};
	return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
