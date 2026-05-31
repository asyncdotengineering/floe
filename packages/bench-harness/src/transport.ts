/**
 * Transport: POST → canonical OpenAI Chat Completions SSE wire that
 * every Floe HTTP surface ships (webAdapter + openaiCompat are both
 * translated by the same mux).
 *
 * Returns a `BenchTurnResponse` carrying the concatenated assistant
 * text, the bench-only `event: floe.run` debug payload (events + final
 * state), and wall-clock TTFT + end-to-end timings.
 *
 * Setting `X-Floe-Debug-Events: 1` toggles the optional `floe.run`
 * extension event the server emits before `[DONE]`. Production traffic
 * MUST NOT set this header; bench/dev tools opt-in to inspect runtime
 * events for assertions like `enteredFlow` / `mentionsNode`.
 */
import type { AssistantOutputEvent, AssistantState } from '@floe/runtime';

export interface BenchTurnResponse {
	text: string;
	events: AssistantOutputEvent[];
	state: AssistantState | undefined;
	ttftMs: number | null;
	endToEndMs: number;
}

export interface SendOpts {
	baseUrl: string;
	sessionId: string;
	message: string;
	userId?: string;
	/** Extra metadata fields. */
	metadata?: Record<string, unknown>;
	/** Default `true`. Set `false` to bench production-shape traffic. */
	debugEvents?: boolean;
	signal?: AbortSignal;
}

export async function send(opts: SendOpts): Promise<BenchTurnResponse> {
	const body: Record<string, unknown> = { message: opts.message };
	const metadata: Record<string, unknown> = { ...(opts.metadata ?? {}) };
	if (opts.userId) metadata.userId = opts.userId;
	if (Object.keys(metadata).length > 0) body.metadata = metadata;

	const headers: Record<string, string> = {
		'content-type': 'application/json',
		accept: 'text/event-stream',
	};
	if (opts.debugEvents !== false) headers['x-floe-debug-events'] = '1';

	const requestStart = performance.now();
	const r = await fetch(`${opts.baseUrl}/agents/web/${opts.sessionId}`, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		signal: opts.signal,
	});
	if (!r.ok) {
		throw new Error(
			`[bench:send] HTTP ${r.status} from ${opts.baseUrl}: ${await r.text().catch(() => '')}`,
		);
	}
	if (!r.body) throw new Error('[bench:send] response has no body');

	const reader = r.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	const events: AssistantOutputEvent[] = [];
	let assistantText = '';
	let firstContentAt: number | null = null;
	let state: AssistantState | undefined;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		// SSE event blocks are separated by blank lines.
		const blocks = buffer.split('\n\n');
		buffer = blocks.pop() ?? '';
		for (const block of blocks) {
			const eventLine = block.split('\n').find((l) => l.startsWith('event: '));
			const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
			if (!dataLine) continue;
			const payload = dataLine.slice('data: '.length);
			if (payload === '[DONE]') continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(payload);
			} catch {
				continue;
			}
			// Named SSE event: `event: floe.run` carries the bench-only
			// debug payload with the full event list + final state.
			if (eventLine === 'event: floe.run') {
				const debug = parsed as {
					events?: AssistantOutputEvent[];
					state?: AssistantState;
				};
				if (Array.isArray(debug.events)) events.push(...debug.events);
				if (debug.state) state = debug.state;
				continue;
			}
			// Default SSE events: OpenAI chat.completion.chunk objects.
			const chunk = parsed as {
				choices?: Array<{
					delta?: { content?: string };
					finish_reason?: string | null;
				}>;
			};
			const delta = chunk.choices?.[0]?.delta;
			if (
				delta?.content &&
				typeof delta.content === 'string' &&
				delta.content.length > 0
			) {
				if (firstContentAt === null) firstContentAt = performance.now();
				assistantText += delta.content;
			}
		}
	}

	const endAt = performance.now();
	return {
		text: assistantText,
		events,
		state,
		ttftMs: firstContentAt === null ? null : Math.round(firstContentAt - requestStart),
		endToEndMs: Math.round(endAt - requestStart),
	};
}
