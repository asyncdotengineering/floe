/**
 * Mux: Flue native SSE → OpenAI Chat Completions SSE.
 *
 * The Flue runtime emits a rich event stream over SSE — text_delta,
 * conversation_event, run_end, thinking_*, operation_*, etc. The mux is
 * the single point where we translate that stream into the canonical
 * wire format every Floe HTTP surface speaks (OpenAI Chat Completions).
 *
 * Two surfaces use this:
 *   - `webAdapter` at `/agents/<channel>/<sessionId>` (Floe-aware mount)
 *   - `openaiCompat` at `/v1/chat/completions` (voice + OpenAI SDK clients)
 *
 * Different URLs, identical wire. There is no second streaming code path
 * to drift out of sync.
 *
 * Buffering: when the caller asks for `Accept: application/json`, the
 * same translation runs, but the chunks are collapsed into one
 * `chat.completion` object before responding. The streaming path is
 * canonical; buffered is the degenerate case.
 *
 * Debug surface: `X-Floe-Debug-Events: 1` adds one extra SSE event
 * `event: floe.run\ndata: {…}\n\n` BEFORE the terminal `data: [DONE]`,
 * carrying the full `{events, state, metrics}` payload. OpenAI consumers
 * ignore events with a non-default `event:` field. This is for benches
 * and dev tools only — production traffic should never set this header.
 */
import type { AssistantOutputEvent } from '../types.ts';
import type {
	OpenAIChatCompletion,
	OpenAIChatCompletionChunk,
} from '../openai-compat/types.ts';
import {
	encodeFlueEvent,
	roleChunk,
	stopChunk,
	type FinishReason,
	type OpenAIChunkContext,
} from './openai-encoder.ts';
import {
	createCitationSanitizer,
	type CitationMode,
} from './citation-sanitizer.ts';

export const SSE_HEADERS: Record<string, string> = {
	'content-type': 'text/event-stream',
	'cache-control': 'no-cache',
	connection: 'keep-alive',
	// Disables proxy buffering (nginx, Cloudflare) so each chunk reaches
	// the client immediately. Without this, intermediaries may hold
	// chunks until a buffer fills, defeating the whole point.
	'x-accel-buffering': 'no',
};

const JSON_HEADERS: Record<string, string> = {
	'content-type': 'application/json',
};

export interface MuxOptions {
	/** Same `{id, model, created}` echoed on every chunk. */
	ctx: OpenAIChunkContext;
	/**
	 * When true, includes one `event: floe.run\ndata: {…}\n\n` extension
	 * before `[DONE]` with the assembled `{events, state}`. Dev-only —
	 * triggered by `X-Floe-Debug-Events: 1` on the request.
	 */
	includeDebugRunEvent?: boolean;
	/**
	 * Citation policy for the active assistant. Threads through to the
	 * streaming citation sanitizer (see `citation-sanitizer.ts`) so
	 * non-numeric bracket patterns the LLM hallucinated get stripped
	 * before they reach the wire. Defaults to `'off'`.
	 */
	citations?: CitationMode;
	/**
	 * When true, the mux buffers text_delta content per LLM operation
	 * and decides whether to emit at the END of the operation:
	 *   - If the operation also calls a flow-entry tool (`enter_<flow>`),
	 *     the buffered text is DROPPED — it's host LLM narration the
	 *     flow's Reply node is about to supersede.
	 *   - Otherwise, the buffered text is FLUSHED as a single content
	 *     chunk to the wire.
	 *
	 * Tradeoff: text streams per LLM-message instead of per-token.
	 * Only meaningful for coordinate-mode assistants with flows defined
	 * (the only case where the bug class can manifest). For direct-mode
	 * or coordinate-without-flows, leave false so per-token streaming
	 * is preserved.
	 *
	 * Defaults to false. The adapter sets this based on
	 * `convo.mode === 'coordinate' && (convo.flows?.length ?? 0) > 0`.
	 */
	bufferHostText?: boolean;
}

/**
 * Stream a Flue upstream Response as OpenAI Chat Completions SSE.
 *
 * Both `webAdapter` and `openaiCompat` call this with the upstream
 * Response they got from the inner Flue dispatcher (when accepting
 * `text/event-stream`). The returned Response is what gets sent to the
 * end client.
 */
export function streamAsOpenAISSE(upstream: Response, opts: MuxOptions): Response {
	if (!upstream.body) {
		return new Response(
			JSON.stringify({
				error: {
					message: 'Upstream Flue response had no body',
					type: 'internal_error',
				},
			}),
			{ status: 502, headers: JSON_HEADERS },
		);
	}
	const { ctx, includeDebugRunEvent = false, citations = 'off', bufferHostText = false } = opts;
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const enc = new TextEncoder();
			// Per-stream citation sanitizer. Strips brackets the LLM
			// hallucinated outside the configured citation grammar
			// (see citation-sanitizer.ts for full semantics).
			const sanitizer = createCitationSanitizer(citations);
			const writeDataChunk = (obj: unknown): void => {
				controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
			};
			const writeNamedEvent = (eventName: string, obj: unknown): void => {
				controller.enqueue(
					enc.encode(`event: ${eventName}\ndata: ${JSON.stringify(obj)}\n\n`),
				);
			};

			// 1) Role marker — OpenAI SDK clients require this to transition
			//    into streaming mode for the response.
			writeDataChunk(roleChunk(ctx));

			let finishReason: FinishReason = 'stop';
			let debugPayload: { events: AssistantOutputEvent[]; state: unknown } | null = null;
			// Tracks whether we emitted any content chunk this turn. Validator
			// short-circuits (escalate/retry) skip the LLM entirely and produce
			// only a final `agent_send_text` with no streamed text_delta. Without
			// this fallback the SSE wire would be empty for those turns —
			// catastrophic for medical / safety templates where the scripted
			// reply IS the user-facing guarantee (see cedar-health).
			let sawContent = false;

			// Per-operation host-text buffer. Only active when
			// `bufferHostText` is true (set by the adapter for
			// coordinate-mode-with-flows assistants — the only case where
			// the flow-text-leak bug class can manifest).
			//
			// Behavior: while inside a host turn that has NOT yet entered
			// a flow, text streams normally per-token. The moment a
			// flow-entry tool_call (`enter_<flow>`) is seen, we set
			// `inFlowTurn = true` and from that point on, all text_delta
			// content is BUFFERED — never emitted live. Pi auto-loops
			// re-prompt the host LLM after each tool call within the same
			// turn, producing more narration that we can't distinguish
			// from the flow's eventual Reply node text at the wire layer.
			// At `run_end` we emit the orchestrator's authoritative
			// composed text (`run_end.result.text`), which excludes host
			// filler by construction. See respond.ts.
			let pendingText = '';
			let inFlowTurn = false;
			const flushPendingText = (): void => {
				if (!pendingText) return;
				const clean = sanitizer.push(pendingText);
				pendingText = '';
				if (clean.length > 0) {
					writeDataChunk(synthContentChunk(ctx, clean));
					sawContent = true;
				}
			};
			const dropPendingText = (): void => {
				pendingText = '';
			};

			try {
				// Body presence was already checked above; narrow the type
				// for the async iterator.
				const body = upstream.body as ReadableStream<Uint8Array>;
				for await (const evt of decodeFlueSSE(body)) {
					// 2a) `run_end` carries the assembled `{text, events, state}`.
					//     Normally text already streamed via text_delta chunks,
					//     so we only pluck events/state for the optional debug
					//     surface. But if NOTHING streamed (validator
					//     short-circuit), emit the final text as a synthetic
					//     content chunk so the wire isn't empty.
					if (evt['type'] === 'run_end') {
						const result = evt['result'] as
							| { events?: AssistantOutputEvent[]; state?: unknown; text?: string }
							| undefined;
						if (result && includeDebugRunEvent) {
							debugPayload = {
								events: Array.isArray(result.events) ? result.events : [],
								state: result.state ?? null,
							};
						}
						// When buffering and we entered a flow this turn,
						// suppress whatever text streamed and emit the
						// orchestrator's authoritative final text instead.
						// This is the only text the user should see for
						// flow turns; everything emitted earlier in this
						// turn was either host narration or intermediate
						// extraction prompts.
						if (bufferHostText && inFlowTurn) {
							dropPendingText();
							const finalText =
								(typeof result?.text === 'string' && result.text.length > 0
									? result.text
									: null) ?? recoverAgentSendText(result?.events);
							if (finalText) {
								const clean = sanitizer.push(finalText);
								if (clean.length > 0) {
									writeDataChunk(synthContentChunk(ctx, clean));
									sawContent = true;
								}
							}
							continue;
						}
						if (!sawContent) {
							const fallbackText =
								(typeof result?.text === 'string' && result.text.length > 0
									? result.text
									: null) ?? recoverAgentSendText(result?.events);
							if (fallbackText) {
								writeDataChunk(synthContentChunk(ctx, fallbackText));
								sawContent = true;
							}
						}
						continue;
					}

					// 2a.1) Live tool-lifecycle bridge (debug-only). Flue
					//        emits `tool_start` (LLM emitted the call) and
					//        `tool_call` (tool returned a result). The
					//        OpenAI Chat Completions wire intentionally hides
					//        these — Flue executes the tool loop server-side
					//        and only the final assistant text reaches the
					//        LLM-client contract. UIs (Floe Studio) WANT
					//        per-call lifecycle inline. So when the caller
					//        opts into `X-Floe-Debug-Events: 1`, we forward
					//        these as named SSE events alongside the default
					//        OpenAI chunks.
					if (includeDebugRunEvent) {
						if (evt['type'] === 'tool_start') {
							writeNamedEvent('floe.tool_start', {
								toolCallId: evt['toolCallId'],
								toolName: evt['toolName'],
								args: evt['args'] ?? null,
							});
							continue;
						}
						if (evt['type'] === 'tool_call') {
							writeNamedEvent('floe.tool_call', {
								toolCallId: evt['toolCallId'],
								toolName: evt['toolName'],
								isError: !!evt['isError'],
								result: evt['result'] ?? null,
								durationMs:
									typeof evt['durationMs'] === 'number' ? evt['durationMs'] : null,
							});
							continue;
						}
					}

					// 2a.2) Operation boundaries — only consumed when
					//        bufferHostText is on. Otherwise the encoder
					//        already drops these events from the wire.
					if (bufferHostText) {
						if (evt['type'] === 'operation_start') {
							dropPendingText();
							continue;
						}
						if (evt['type'] === 'operation') {
							// Once we've entered a flow this turn, NEVER
							// flush mid-stream — all subsequent text is
							// either host narration or intermediate flow
							// node prompts. We emit only the final
							// authoritative text at `run_end` (see above).
							if (inFlowTurn) {
								dropPendingText();
							} else {
								flushPendingText();
							}
							continue;
						}
						// 2a.3) Detect flow-entry tool_call BEFORE the
						// encoder runs. The real Flue event uses
						// `toolName` (not `name`), so the post-encode
						// check on `delta.tool_calls[].function.name`
						// wouldn't fire for production events — only for
						// synthetic test events that happen to set
						// `name`. Checking the raw event here covers both.
						if (evt['type'] === 'tool_call') {
							const tn = typeof evt['toolName'] === 'string' ? evt['toolName'] : '';
							if (tn.startsWith('enter_')) {
								inFlowTurn = true;
								dropPendingText();
							}
						}
					}

					// 2b) Translate the event. The encoder returns `null` for
					//     anything that doesn't belong on the wire.
					const openaiChunk = encodeFlueEvent(evt, ctx);
					if (!openaiChunk) continue;

					// If the model emitted any tool_calls, the finish reason
					// becomes `tool_calls` rather than `stop`. We detect by
					// checking the delta we just produced.
					const toolCalls = openaiChunk.choices[0]?.delta.tool_calls;
					if (toolCalls?.length) {
						finishReason = 'tool_calls';
						// When buffering, a flow-entry tool_call cancels any
						// host text accumulated in the same operation. Other
						// tool_calls flush the buffer (the text was
						// legitimate narration like "let me look that up").
						if (bufferHostText) {
							const looksLikeFlowEntry = toolCalls.some(
								(tc) =>
									typeof tc.function?.name === 'string' &&
									tc.function.name.startsWith('enter_'),
							);
							if (looksLikeFlowEntry) {
								dropPendingText();
							} else {
								flushPendingText();
							}
						}
					}
					// 2b.1) Citation sanitizer — strip hallucinated
					// bracket patterns from content deltas before they
					// reach the wire. Skips empty deltas (sanitizer may
					// fully strip a chunk that was only a `]`-closing).
					const content = openaiChunk.choices[0]?.delta.content;
					if (typeof content === 'string' && content.length > 0) {
						if (bufferHostText) {
							// Hold the chunk; it'll either flush or drop
							// when the operation completes. Citation
							// sanitization runs at flush time so its
							// per-stream state doesn't get polluted by
							// dropped text.
							pendingText += content;
							continue;
						}
						const clean = sanitizer.push(content);
						if (clean.length === 0) continue;
						openaiChunk.choices[0]!.delta.content = clean;
						sawContent = true;
					}
					writeDataChunk(openaiChunk);
				}
				// 2c) Final flush in case the stream ended mid-operation
				//     (no terminal `operation` event arrived).
				if (bufferHostText) flushPendingText();

				// 2c) Drain the sanitizer — a stream ending mid-bracket
				//     would otherwise swallow the buffered text. The
				//     leftover (if any) goes out as one final content
				//     chunk before the stop marker.
				const trailing = sanitizer.flush();
				if (trailing.length > 0) {
					writeDataChunk(synthContentChunk(ctx, trailing));
					sawContent = true;
				}

				// 3) Stop chunk with the appropriate finish_reason.
				writeDataChunk(stopChunk(ctx, finishReason));

				// 4) Debug extension (opt-in only). Lives BEFORE [DONE] so
				//    that consumers which close on [DONE] still get it. Uses
				//    a named SSE event so OpenAI SDK clients (which only
				//    parse default `data:` events as chunks) ignore it.
				if (debugPayload) {
					writeNamedEvent('floe.run', debugPayload);
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				writeDataChunk({
					error: { message, type: 'internal_error' },
				});
			} finally {
				// 5) Terminal. OpenAI's spec — consumers stop reading after this.
				controller.enqueue(enc.encode('data: [DONE]\n\n'));
				controller.close();
			}
		},
	});
	return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

/**
 * Collapse the same Flue stream into one buffered `chat.completion`
 * object. Used when the caller explicitly opts out of streaming via
 * `Accept: application/json`. Same encoder, just aggregated.
 */
export async function bufferAsOpenAIJson(
	upstream: Response,
	ctx: OpenAIChunkContext,
	citations: CitationMode = 'off',
	bufferHostText: boolean = false,
): Promise<Response> {
	if (!upstream.body) {
		return new Response(
			JSON.stringify({
				error: { message: 'Upstream Flue response had no body', type: 'internal_error' },
			}),
			{ status: 502, headers: JSON_HEADERS },
		);
	}
	const sanitizer = createCitationSanitizer(citations);
	let content = '';
	const toolCalls: NonNullable<OpenAIChatCompletion['choices'][0]['message']['tool_calls']> = [];
	let finishReason: FinishReason = 'stop';
	let fallbackFromRunEnd: string | null = null;
	// Per-operation host-text buffer (opt-in, see streaming-path
	// counterpart in MuxOptions.bufferHostText for full rationale).
	let pendingOp = '';
	let inFlowTurn = false;
	for await (const evt of decodeFlueSSE(upstream.body)) {
		// Capture run_end fallback for the validator-short-circuit case.
		if (evt['type'] === 'run_end') {
			const result = evt['result'] as
				| { events?: AssistantOutputEvent[]; text?: string }
				| undefined;
			fallbackFromRunEnd =
				(typeof result?.text === 'string' && result.text.length > 0
					? result.text
					: null) ?? recoverAgentSendText(result?.events);
			if (bufferHostText && inFlowTurn) {
				// Discard whatever streamed; the orchestrator's
				// `run_end.result.text` (captured into fallbackFromRunEnd
				// above) is the authoritative answer for flow turns.
				content = '';
				pendingOp = '';
			}
			continue;
		}
		if (bufferHostText) {
			if (evt['type'] === 'operation_start') {
				pendingOp = '';
				continue;
			}
			if (evt['type'] === 'operation') {
				if (inFlowTurn) pendingOp = '';
				else content += sanitizer.push(pendingOp);
				pendingOp = '';
				continue;
			}
			if (evt['type'] === 'tool_call') {
				const tn = typeof evt['toolName'] === 'string' ? evt['toolName'] : '';
				if (tn.startsWith('enter_')) {
					inFlowTurn = true;
					pendingOp = '';
				}
			}
		}
		const openaiChunk = encodeFlueEvent(evt, ctx);
		if (!openaiChunk) continue;
		const delta = openaiChunk.choices[0]?.delta;
		if (delta?.content) {
			if (bufferHostText) pendingOp += delta.content;
			else content += sanitizer.push(delta.content);
		}
		if (delta?.tool_calls?.length) {
			finishReason = 'tool_calls';
			if (bufferHostText) {
				const looksLikeFlowEntry = delta.tool_calls.some(
					(tc) =>
						typeof tc.function?.name === 'string' &&
						tc.function.name.startsWith('enter_'),
				);
				if (looksLikeFlowEntry) pendingOp = '';
				else {
					content += sanitizer.push(pendingOp);
					pendingOp = '';
				}
			}
			for (const tc of delta.tool_calls) {
				// Strip the streaming-only `index` if present.
				const { id, type, function: fn } = tc as { id: string; type: 'function'; function: { name: string; arguments: string } };
				toolCalls.push({ id, type, function: { ...fn } });
			}
		}
	}
	if (bufferHostText && pendingOp) {
		content += sanitizer.push(pendingOp);
		pendingOp = '';
	}
	content += sanitizer.flush();
	// Validator short-circuit fallback (mirrors the streaming path).
	if (content.length === 0 && fallbackFromRunEnd) {
		// Sanitize the fallback too — same hallucination class can appear
		// in validator-short-circuit text.
		const fbSanitizer = createCitationSanitizer(citations);
		content = fbSanitizer.push(fallbackFromRunEnd) + fbSanitizer.flush();
	}
	const completion: OpenAIChatCompletion = {
		id: ctx.id,
		object: 'chat.completion',
		created: ctx.created,
		model: ctx.model,
		choices: [
			{
				index: 0,
				message: {
					role: 'assistant',
					content,
					...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
				},
				finish_reason: finishReason,
			},
		],
		// Token counts come from the runtime metrics surface; the response
		// shape carries zeros if we can't read them here. Real cost data
		// lives on the observability sink.
		usage: { prompt_tokens: 0, completion_tokens: estimateTokens(content), total_tokens: estimateTokens(content) },
	};
	return new Response(JSON.stringify(completion), { status: 200, headers: JSON_HEADERS });
}

/**
 * Parse a Flue SSE byte stream into the structured events it carries.
 * Yields each event object as soon as it lands; backpressure naturally
 * flows because we await the next chunk from the upstream reader.
 */
async function* decodeFlueSSE(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			// SSE event boundaries are blank lines. Within an event, the
			// `data:` field carries the JSON payload. We tolerate one event
			// per blank-line block (Flue emits exactly one).
			const blocks = buffer.split('\n\n');
			buffer = blocks.pop() ?? '';
			for (const block of blocks) {
				const dataLine = block
					.split('\n')
					.find((line) => line.startsWith('data: '));
				if (!dataLine) continue;
				const payload = dataLine.slice('data: '.length).trim();
				if (!payload || payload === '[DONE]') continue;
				try {
					yield JSON.parse(payload) as Record<string, unknown>;
				} catch {
					// Malformed payload — drop. We can't recover and the
					// upstream contract is internal.
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Synthetic single-shot content chunk. Used by the validator-short-
 * circuit fallback so the OpenAI SSE wire isn't empty when a preLLM
 * validator returns escalate/retry (no text_delta stream, only a
 * final `agent_send_text`). Mirrors the chunk() helper in the
 * encoder, kept inline here so the mux owns the fallback shape.
 */
function synthContentChunk(
	ctx: OpenAIChunkContext,
	text: string,
): OpenAIChatCompletionChunk {
	return {
		id: ctx.id,
		object: 'chat.completion.chunk',
		created: ctx.created,
		model: ctx.model,
		choices: [
			{
				index: 0,
				delta: { content: text },
				finish_reason: null,
			},
		],
	};
}

/**
 * Find the first non-empty `agent_send_text` text in a Flue events array.
 * The orchestrator emits this for the final assistant text — including
 * the `[Escalating to X: ...]` shape produced by validator short-circuits.
 */
function recoverAgentSendText(
	events: AssistantOutputEvent[] | undefined,
): string | null {
	if (!Array.isArray(events)) return null;
	for (const e of events) {
		if (
			e.type === 'agent_send_text' &&
			typeof e.text === 'string' &&
			e.text.length > 0
		) {
			return e.text;
		}
	}
	return null;
}
