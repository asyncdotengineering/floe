/**
 * Pure translation: Flue runtime event → OpenAI Chat Completions chunk.
 *
 * One canonical wire for every Floe HTTP surface. The same encoder powers
 * `webAdapter` and `openaiCompat` — different URLs and auth, identical
 * wire. The chunk shape matches OpenAI's `chat.completion.chunk` exactly
 * so any OpenAI SDK client, AI SDK consumer, or voice platform (Vapi,
 * ElevenLabs, LiveKit, Pipecat) interoperates without a translation
 * layer.
 *
 * What we translate:
 *   - `text_delta.text`         → choices[0].delta.content      (the per-token stream)
 *   - `tool_call` (full call)   → choices[0].delta.tool_calls   (single-shot translation;
 *                                                                Flue emits the assembled call,
 *                                                                not the argument byte stream)
 *
 * What we drop from the wire (these belong on the observability sink,
 * not in the response body):
 *   - `run_start`, `run_end`, `operation_start`, `operation`, `idle`, `turn`
 *   - `thinking_start`, `thinking_delta`, `thinking_end`
 *   - `conversation_event` (turn_start, knowledge_query, knowledge_hit, validator_result, …)
 *   - `agent_send_text` (already covered by text_delta sequencing within the same operation)
 *   - `text` (operation-level finalization; redundant with text_delta)
 *   - `tool_start` (we surface the call when complete via `tool_call`)
 */
import type {
	OpenAIChatCompletionChunk,
	OpenAIChatCompletionChunkChoice,
	OpenAIToolCall,
} from '../openai-compat/types.ts';

export interface OpenAIChunkContext {
	/** `chatcmpl-…` id. Same across every chunk for one response. */
	id: string;
	/** Unix seconds. Same across every chunk for one response. */
	created: number;
	/** Echoed back as `model` on every chunk. Whatever the caller requested. */
	model: string;
}

export type FinishReason = NonNullable<OpenAIChatCompletionChunkChoice['finish_reason']>;

/**
 * Make a chunk with an arbitrary delta + optional terminal finish_reason.
 * Internal helper — callers should prefer the named helpers below for
 * the cases we care about.
 */
function chunk(
	ctx: OpenAIChunkContext,
	delta: OpenAIChatCompletionChunkChoice['delta'],
	finishReason: FinishReason | null,
): OpenAIChatCompletionChunk {
	return {
		id: ctx.id,
		object: 'chat.completion.chunk',
		created: ctx.created,
		model: ctx.model,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
}

/** Opens a streaming response — the role marker every OpenAI SDK client looks for. */
export function roleChunk(ctx: OpenAIChunkContext): OpenAIChatCompletionChunk {
	return chunk(ctx, { role: 'assistant' }, null);
}

/** Closes a streaming response. Use `tool_calls` when the LLM finished by emitting tools. */
export function stopChunk(
	ctx: OpenAIChunkContext,
	finishReason: FinishReason = 'stop',
): OpenAIChatCompletionChunk {
	return chunk(ctx, {}, finishReason);
}

/**
 * Translate a single Flue event to an OpenAI chunk, or `null` if the
 * event has no user-facing wire representation. `null` returns are
 * dropped silently — they belong on the observability sink.
 */
export function encodeFlueEvent(
	evt: Record<string, unknown>,
	ctx: OpenAIChunkContext,
): OpenAIChatCompletionChunk | null {
	const type = typeof evt['type'] === 'string' ? (evt['type'] as string) : '';

	if (type === 'text_delta') {
		const text = evt['text'];
		if (typeof text !== 'string' || text.length === 0) return null;
		return chunk(ctx, { content: text }, null);
	}

	if (type === 'tool_call') {
		// Flue emits the FULL tool call (id, name, assembled JSON args) as one
		// event. We translate that to the OpenAI chunked tool_calls shape in
		// a single delta — OpenAI SDK clients accumulate deltas keyed by
		// `index` and a single complete delta is the degenerate case.
		//
		// Defensive: many internal Flue subsystems also emit `tool_call` for
		// their own bookkeeping with no name attached (compaction, lifecycle
		// markers, role broadcasts). Those don't represent a real LLM tool
		// call and must NOT appear on the wire — drop them.
		const name = typeof evt['name'] === 'string' ? evt['name'] : '';
		if (!name) return null;
		const id = typeof evt['callId'] === 'string' && evt['callId'].length > 0
			? (evt['callId'] as string)
			: `call_${Math.random().toString(36).slice(2, 10)}`;
		const args = evt['args'];
		const argsString = typeof args === 'string' ? args : JSON.stringify(args ?? {});
		const toolCall: OpenAIToolCall = {
			id,
			type: 'function',
			function: { name, arguments: argsString },
		};
		// The chunk shape wants `tool_calls: OpenAIToolCall[]` per the types
		// we already publish; OpenAI's wire also accepts `index` on each
		// element. We use the indexed variant the SDK expects.
		const indexedCall = { index: 0, ...toolCall } as unknown as OpenAIToolCall;
		return chunk(ctx, { tool_calls: [indexedCall] }, null);
	}

	return null;
}
