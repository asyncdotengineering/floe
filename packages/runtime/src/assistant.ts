/**
 * Assistant — the v1 BLUEPRINT primary primitive.
 *
 * A long-lived, configured handler that turns user messages into actions +
 * replies. Construct with `new Assistant({...})`. Reuse across requests.
 *
 * The single call site is `assistant.run(userMessage, args)`, which returns
 * a `TurnHandle` (awaitable + iterable + cancellable + ReadableStream-able).
 *
 * See docs/BLUEPRINT.md §3 (primitive), §4 (modes), §5 (run API).
 */
import type { AssistantConfig, AssistantMode, AssistantOutputEvent, Channel } from './types.ts';
import type { TranscriptMessage } from './transcript-store.ts';
import type { TurnMetrics } from './observability/types.ts';
import { createFloeApp, type FloeApp } from './create-floe-app.ts';
import { webChannel } from './web-channel.ts';

// Re-exported for users who want to construct args by name.
export interface RunArgs {
	sessionId: string;
	userId?: string;
	metadata?: Record<string, unknown>;
	signal?: AbortSignal;
	overlay?: {
		mode?: AssistantMode;
		systemPromptOverlay?: string;
		maxResponseTokens?: number;
		sequentialToolUse?: boolean;
	};
}

export interface TurnOutput {
	runId: string;
	sessionId: string;
	userId?: string;
	content: string;
	messages: TranscriptMessage[];
	metrics?: TurnMetrics;
	mode: AssistantMode;
	routedTo?: string;
	tasks?: { count: number; totalMs: number; errors: number };
	broadcastFanout?: number;
	compaction?: { count: number; totalMs: number; messagesDropped: number };
	interrupted: boolean;
}

export interface TurnHandle extends Promise<TurnOutput> {
	readonly events: AsyncIterable<AssistantOutputEvent>;
	toResponseStream(format?: 'sse' | 'ndjson'): ReadableStream<Uint8Array>;
	cancel(reason?: string): void;
	readonly signal: AbortSignal;
}

/**
 * Assistant — the primary Floe primitive.
 *
 * `assistant.run(userMessage, args)` is the canonical call site. Returns
 * a `TurnHandle` that is awaitable (for the final TurnOutput), iterable
 * (for streaming events), and pipeable to an HTTP response stream.
 *
 * The Flue runtime is bootstrapped lazily on first run() or first adapter
 * mount. Adapters (e.g. `webAdapter` from `@floe/adapter-web`) reuse the
 * same lazy-bootstrapped app via `assistant._app()`.
 */
export class Assistant {
	readonly config: AssistantConfig;
	private _cached: FloeApp | undefined;

	constructor(config: AssistantConfig) {
		this.config = Object.freeze(config);
	}

	/**
	 * Internal: bootstrap the underlying Floe app on first call, cached.
	 * Adapters (e.g. `webAdapter`) call this; programmatic `run()` calls
	 * it through `getApp()`. Application code should not call this
	 * directly — use `run()` or mount via an adapter.
	 */
	_app(channels: Record<string, Channel>): FloeApp {
		if (this._cached) return this._cached;
		const cfg = this.config;
		if (!cfg.model) {
			throw new Error(
				`[floe] Assistant "${cfg.name}" has no \`model\`. Set \`model\` on the Assistant before mounting or calling run().`,
			);
		}
		if (cfg.sandbox === undefined) {
			throw new Error(
				`[floe] Assistant "${cfg.name}" has no \`sandbox\`. Set \`sandbox: localSandbox()\` (or another factory / false) on the Assistant.`,
			);
		}
		const state = cfg.state ?? {};
		this._cached = createFloeApp({
			assistants: { [cfg.name]: cfg },
			channels,
			...(state.sessionStore ? { sessionStore: state.sessionStore } : {}),
			...(state.assistantStateStore ? { assistantStateStore: state.assistantStateStore } : {}),
			...(state.transcriptStore ? { transcriptStore: state.transcriptStore } : {}),
			defaults: {
				model: cfg.model,
				sandbox: cfg.sandbox,
				...(cfg.thinkingLevel !== undefined ? { thinkingLevel: cfg.thinkingLevel } : {}),
				...(cfg.memory ? { memory: cfg.memory } : {}),
				...(cfg.observability !== undefined ? { observability: cfg.observability } : {}),
				...(cfg.compaction !== undefined ? { compaction: cfg.compaction } : {}),
				...(cfg.rateLimit !== undefined ? { rateLimit: cfg.rateLimit } : {}),
				...(cfg.mcp !== undefined ? { mcp: cfg.mcp } : {}),
			},
		});
		return this._cached;
	}

	private getApp(): { fetch: (req: Request, ...rest: unknown[]) => Response | Promise<Response> } {
		return this._app({ web: webChannel });
	}

	get name(): string {
		return this.config.name;
	}

	get mode(): AssistantMode {
		return this.config.mode ?? 'direct';
	}

	get roleNames(): string[] {
		return Object.keys(this.config.roles ?? {});
	}

	/**
	 * Run one turn. Returns a TurnHandle:
	 *   - `await handle` → final TurnOutput (content, metrics, etc.)
	 *   - `for await (const ev of handle.events)` → stream events
	 *   - `handle.toResponseStream('sse')` → HTTP body for an adapter
	 *   - `handle.cancel(reason)` → abort the in-flight turn
	 */
	run(userMessage: string, args: RunArgs): TurnHandle {
		const app = this.getApp();
		const ac = new AbortController();
		const externalSignal = args.signal;
		if (externalSignal) {
			if (externalSignal.aborted) ac.abort(externalSignal.reason);
			else externalSignal.addEventListener('abort', () => ac.abort(externalSignal.reason), { once: true });
		}

		const req = new Request(`http://local/agents/web/${args.sessionId}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
			body: JSON.stringify({
				message: userMessage,
				...(args.userId ? { metadata: { ...(args.metadata ?? {}), userId: args.userId } } : args.metadata ? { metadata: args.metadata } : {}),
			}),
			signal: ac.signal,
		});

		const responsePromise = Promise.resolve(app.fetch(req));

		// The TurnHandle is a Promise<TurnOutput> with extra members.
		// We build it as a real Promise so `await handle` works, then
		// attach the convenience properties.
		const captured: { content: string; events: AssistantOutputEvent[] } = {
			content: '',
			events: [],
		};
		let consumed = false;

		const consume = async (): Promise<TurnOutput> => {
			if (consumed) {
				throw new Error('[floe] TurnHandle already consumed');
			}
			consumed = true;
			const res = await responsePromise;
			if (!res.body) {
				throw new Error('[floe] Assistant.run: response has no body');
			}
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let runId = '';
			let mode: AssistantMode = this.mode;
			let routedTo: string | undefined;
			let interrupted = false;
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';
				for (const line of lines) {
					if (!line.startsWith('data: ')) continue;
					const payload = line.slice(6).trim();
					if (!payload || payload === '[DONE]') continue;
					try {
						const evt = JSON.parse(payload) as Record<string, unknown>;
						captured.events.push(evt as AssistantOutputEvent);
						if (evt.type === 'agent_send_partial' && typeof evt.delta === 'string') {
							captured.content += evt.delta;
						} else if (evt.type === 'agent_send_text' && typeof evt.text === 'string' && !captured.content) {
							captured.content = evt.text;
						} else if (evt.type === 'text_delta' && typeof evt.text === 'string') {
							captured.content += evt.text;
						} else if (evt.type === 'run_end') {
							// The orchestrator bundles its final composed
							// `text` into `run_end.result` (Floe handler →
							// `{text, events, state}`). That text is the
							// authoritative answer for this turn — it
							// EXCLUDES host filler that streamed as
							// text_delta but was superseded by a flow's
							// Reply node (see flow-text-leak bug). When
							// present, it OVERRIDES the text_delta
							// accumulation. The streamed deltas are still
							// fine for live UX up to this point; the
							// override fixes the FINAL captured.content
							// that programmatic consumers read.
							//
							// Also: agent_send_text events live inside
							// result.events (Flue bundles handler events
							// into run_end rather than emitting them
							// separately on the wire). Scan as a fallback
							// in case the handler returned events without
							// a top-level result.text.
							const result = (evt as {
								result?: {
									text?: string;
									events?: Array<Record<string, unknown>>;
								};
							}).result;
							if (result && typeof result.text === 'string' && result.text.length > 0) {
								captured.content = result.text;
							} else if (result?.events) {
								for (const inner of result.events) {
									if (
										inner.type === 'agent_send_text' &&
										typeof inner.text === 'string' &&
										inner.text.length > 0
									) {
										captured.content = inner.text;
									}
								}
							}
						} else if (evt.type === 'conversation_event' && (evt as { subtype?: string }).subtype === 'turn_interrupted') {
							interrupted = true;
						}
					} catch {
						// ignore non-JSON SSE lines
					}
				}
			}
			runId = res.headers.get('x-flue-run-id') ?? '';
			return {
				runId,
				sessionId: args.sessionId,
				userId: args.userId,
				content: captured.content,
				messages: [],
				mode,
				routedTo,
				interrupted,
			};
		};

		const promise = consume();
		const handle = promise as TurnHandle;
		// Attach the iterable + stream + cancel convenience.
		Object.defineProperty(handle, 'events', {
			value: (async function* (): AsyncIterable<AssistantOutputEvent> {
				await promise;
				for (const e of captured.events) yield e;
			})(),
		});
		Object.defineProperty(handle, 'toResponseStream', {
			value: (format: 'sse' | 'ndjson' = 'sse') => {
				return new ReadableStream<Uint8Array>({
					async start(controller) {
						const enc = new TextEncoder();
						await promise.catch(() => undefined);
						for (const e of captured.events) {
							const line =
								format === 'ndjson'
									? `${JSON.stringify(e)}\n`
									: `data: ${JSON.stringify(e)}\n\n`;
							controller.enqueue(enc.encode(line));
						}
						controller.close();
					},
				});
			},
		});
		Object.defineProperty(handle, 'cancel', {
			value: (reason?: string) => ac.abort(reason ?? 'cancelled'),
		});
		Object.defineProperty(handle, 'signal', { value: ac.signal });
		return handle;
	}
}
