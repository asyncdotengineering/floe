/**
 * POST /api/chat — proxy that bridges Floe's debug-events SSE into the
 * AI SDK v5 Data Stream protocol with custom `data-*` parts for the
 * agent-side runtime signals (tool calls + sources).
 *
 * Why custom SSE bridging instead of `streamText` + `@ai-sdk/openai`?
 *   - `streamText` consumes OpenAI Chat Completions chunks (text only,
 *     plus tool_calls when surfaced — Floe strips them by design).
 *   - We need to surface Floe's named SSE events: `floe.run`,
 *     `floe.tool_start`, `floe.tool_call`. These don't exist in the
 *     OpenAI wire — they're the Floe debug-events extension.
 *   - Emitting custom AI SDK `data-*` parts lets the React app render
 *     tool calls + sources inline using AI Elements components.
 *
 * Wire in:  { messages: UIMessage[], sessionId?: string, agentUrl?: string }
 * Wire out: AI SDK v5 UI Message Stream (text-delta + data-source + data-tool)
 *
 * Agent URL precedence:
 *   - request body `agentUrl` (set by Settings dialog → client transport)
 *   - process.env.FLOE_AGENT_URL (server-side default)
 *   - http://localhost:3110
 */
import { createFileRoute } from '@tanstack/react-router';
import type { UIMessage } from 'ai';

interface ChatRequestBody {
	messages: UIMessage[];
	sessionId?: string;
	agentUrl?: string;
}

function resolveAgentUrl(bodyUrl?: string): string {
	const env = process.env.FLOE_AGENT_URL;
	const fromBody = bodyUrl?.trim().replace(/\/$/, '');
	const fromEnv = env?.trim().replace(/\/$/, '');
	return fromBody || fromEnv || 'http://localhost:3110';
}

/**
 * Extract just the user-side text from a v5 UIMessage[] history. Floe
 * maintains conversation state server-side per sessionId, so we only
 * need to forward the LATEST user message — not the entire history
 * (Floe replays from its own session store).
 */
function latestUserText(messages: UIMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== 'user') continue;
		const text = m.parts
			.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
			.map((p) => p.text)
			.join('');
		if (text.trim()) return text;
	}
	return '';
}

export const Route = createFileRoute('/api/chat')({
	server: {
		handlers: {
			POST: async ({ request }: { request: Request }) => {
				let body: ChatRequestBody;
				try {
					body = (await request.json()) as ChatRequestBody;
				} catch {
					return new Response(JSON.stringify({ error: 'bad json' }), {
						status: 400,
						headers: { 'content-type': 'application/json' },
					});
				}
				const message = latestUserText(body.messages ?? []);
				if (!message) {
					return new Response(JSON.stringify({ error: 'no user message' }), {
						status: 400,
						headers: { 'content-type': 'application/json' },
					});
				}
				const sessionId = body.sessionId ?? `studio-${crypto.randomUUID()}`;
				const agentUrl = resolveAgentUrl(body.agentUrl);

				// Hit Floe's webAdapter directly (not openai-compat) so we
				// get the named debug events: floe.run, floe.tool_start,
				// floe.tool_call.
				const upstream = await fetch(`${agentUrl}/agents/web/${encodeURIComponent(sessionId)}`, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						accept: 'text/event-stream',
						'x-floe-debug-events': '1',
					},
					body: JSON.stringify({ message }),
				});
				if (!upstream.ok || !upstream.body) {
					const errBody = upstream.body ? await upstream.text() : 'no body';
					return new Response(
						JSON.stringify({ error: 'upstream_failed', status: upstream.status, body: errBody.slice(0, 500) }),
						{ status: 502, headers: { 'content-type': 'application/json' } },
					);
				}

				const stream = bridgeFloeToAiSdk(upstream.body);
				return new Response(stream, {
					status: 200,
					headers: {
						'content-type': 'text/event-stream',
						'cache-control': 'no-cache, no-transform',
						connection: 'keep-alive',
						'x-vercel-ai-ui-message-stream': 'v1',
						'x-accel-buffering': 'no',
					},
				});
			},
		},
	},
});

/**
 * Pipe Floe's OpenAI-shaped SSE + named debug events into the AI SDK
 * v5 UI Message Stream format.
 *
 * Output frame types we emit:
 *   - `start`, `start-step` (lifecycle)
 *   - `text-start`, `text-delta`, `text-end` (the assistant text)
 *   - `data-source` (custom, from each `conversation_event:knowledge_hit`)
 *   - `data-tool` (custom, paired from `floe.tool_start` + `floe.tool_call`)
 *   - `finish-step`, `finish` (lifecycle)
 *   - `[DONE]` (terminal)
 */
function bridgeFloeToAiSdk(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	const TEXT_ID = '0';
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (obj: unknown) => {
				controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
			};
			const done = () => controller.enqueue(enc.encode('data: [DONE]\n\n'));

			send({ type: 'start' });
			send({ type: 'start-step' });
			let textStarted = false;
			let textEnded = false;
			const openStart = () => {
				if (textStarted) return;
				textStarted = true;
				send({ type: 'text-start', id: TEXT_ID });
			};
			const closeText = () => {
				if (textStarted && !textEnded) {
					textEnded = true;
					send({ type: 'text-end', id: TEXT_ID });
				}
			};

			// Paired tool state: floe.tool_start → store; floe.tool_call →
			// emit a single `data-tool` block with both args + result.
			const pendingTools = new Map<string, { toolName: string; args: unknown }>();

			try {
				for await (const evt of decodeSse(upstream)) {
					if (evt.event === 'floe.tool_start') {
						const data = evt.data as { toolCallId?: string; toolName?: string; args?: unknown } | null;
						if (data?.toolCallId && data.toolName) {
							pendingTools.set(data.toolCallId, {
								toolName: data.toolName,
								args: data.args,
							});
							// Optimistic UI: emit a "running" data-tool now.
							send({
								type: `data-tool`,
								id: data.toolCallId,
								data: {
									toolCallId: data.toolCallId,
									toolName: data.toolName,
									args: data.args,
									status: 'running',
								},
							});
						}
						continue;
					}
					if (evt.event === 'floe.tool_call') {
						const data = evt.data as {
							toolCallId?: string;
							toolName?: string;
							isError?: boolean;
							result?: unknown;
							durationMs?: number | null;
						} | null;
						if (data?.toolCallId) {
							const pending = pendingTools.get(data.toolCallId);
							pendingTools.delete(data.toolCallId);
							send({
								type: `data-tool`,
								id: data.toolCallId,
								data: {
									toolCallId: data.toolCallId,
									toolName: data.toolName ?? pending?.toolName ?? 'tool',
									args: pending?.args,
									result: data.result,
									isError: !!data.isError,
									durationMs: data.durationMs ?? null,
									status: data.isError ? 'error' : 'done',
								},
							});
						}
						continue;
					}
					if (evt.event === 'floe.run') {
						const payload = evt.data as { events?: unknown[] } | null;
						if (Array.isArray(payload?.events)) {
							const flowSteps: Array<{
								kind:
									| 'flow_enter'
									| 'flow_exit'
									| 'node_enter'
									| 'node_exit'
									| 'extraction_submission';
								name: string;
							}> = [];
							for (const e of payload.events as Array<Record<string, unknown>>) {
								if (e.type !== 'conversation_event') continue;
								const sub = e.subtype as string;
								const d = (e.data ?? {}) as Record<string, unknown>;
								// Knowledge sources → data-source
								if (sub === 'knowledge_hit') {
									send({
										type: `data-source`,
										data: {
											source: (d.source as string) ?? 'unknown',
											count: (d.count as number) ?? 0,
											topScore: (d.topScore as number) ?? null,
										},
									});
									continue;
								}
								// Flow lifecycle → accumulated into one data-flow part
								if (
									sub === 'flow_enter' ||
									sub === 'flow_exit' ||
									sub === 'node_enter' ||
									sub === 'node_exit' ||
									sub === 'extraction_submission'
								) {
									// Event data shapes from packages/runtime/src/orchestrator
									// (transition-reducer.ts + respond.ts):
									//   flow_enter:            { flow, node, args }
									//   flow_exit:             { handoffTo?, reason? }
									//   node_enter:            { from, to }
									//   node_exit:             { from?, to? } (legacy)
									//   extraction_submission: { node, submitted, missing, complete }
									const name =
										sub === 'flow_enter'
											? (d.flow as string)
											: sub === 'node_enter' || sub === 'node_exit'
												? (d.to as string) || (d.from as string)
												: sub === 'extraction_submission'
													? (d.node as string)
													: (d.handoffTo as string) || (d.flow as string);
									flowSteps.push({
										kind: sub as
											| 'flow_enter'
											| 'flow_exit'
											| 'node_enter'
											| 'node_exit'
											| 'extraction_submission',
										name: name || '?',
									});
								}
							}
							// Emit ONE consolidated data-flow part per turn so the
							// renderer can show a single breadcrumb above the
							// assistant message:  signup › collect-info → submit → end
							if (flowSteps.length > 0) {
								send({ type: 'data-flow', data: { steps: flowSteps } });
							}
						}
						continue;
					}

					// Default (unnamed) SSE event = an OpenAI chat.completion.chunk
					if (evt.event === null) {
						const payload = evt.data;
						if (payload === '[DONE]' || payload == null) continue;
						const chunk = payload as {
							choices?: Array<{
								delta?: { content?: string };
								finish_reason?: string | null;
							}>;
						};
						const delta = chunk.choices?.[0]?.delta;
						if (delta?.content && typeof delta.content === 'string' && delta.content.length > 0) {
							openStart();
							send({ type: 'text-delta', id: TEXT_ID, delta: delta.content });
						}
					}
				}
				closeText();
				send({ type: 'finish-step' });
				send({ type: 'finish', finishReason: 'stop' });
			} catch (err) {
				closeText();
				send({
					type: 'error',
					errorText: err instanceof Error ? err.message : 'stream error',
				});
				send({ type: 'finish', finishReason: 'error' });
			} finally {
				done();
				controller.close();
			}
		},
	});
}

interface ParsedSse {
	event: string | null;
	data: unknown;
}

async function* decodeSse(body: ReadableStream<Uint8Array>): AsyncGenerator<ParsedSse> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const blocks = buffer.split('\n\n');
			buffer = blocks.pop() ?? '';
			for (const block of blocks) {
				const lines = block.split('\n');
				const eventLine = lines.find((l) => l.startsWith('event: '));
				const dataLine = lines.find((l) => l.startsWith('data: '));
				if (!dataLine) continue;
				const raw = dataLine.slice('data: '.length);
				if (raw === '[DONE]') {
					yield { event: null, data: '[DONE]' };
					continue;
				}
				let data: unknown = null;
				try {
					data = JSON.parse(raw);
				} catch {
					data = raw;
				}
				yield {
					event: eventLine ? eventLine.slice('event: '.length) : null,
					data,
				};
			}
		}
	} finally {
		reader.releaseLock();
	}
}
