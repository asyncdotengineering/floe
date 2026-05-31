/**
 * Streaming — one canonical wire for every Floe HTTP surface.
 *
 * Both `webAdapter` and `openaiCompat` use this. Same encoder, same wire,
 * different routing. See `mux.ts` for the design rationale.
 */
export {
	streamAsOpenAISSE,
	bufferAsOpenAIJson,
	SSE_HEADERS,
	type MuxOptions,
} from './mux.ts';
export {
	encodeFlueEvent,
	roleChunk,
	stopChunk,
	type OpenAIChunkContext,
	type FinishReason,
} from './openai-encoder.ts';

/** Stable id for one chat-completion response, used across every chunk. */
export function newCompletionId(): string {
	return `chatcmpl-${Math.random().toString(36).slice(2, 12)}`;
}

/** Did the caller explicitly request the buffered JSON envelope? */
export function callerWantsBufferedJson(req: Request): boolean {
	const accept = req.headers.get('accept') ?? '';
	if (!accept) return false;
	return /\bapplication\/json\b/.test(accept) && !/\btext\/event-stream\b/.test(accept);
}

/** Did the caller opt into the dev-only `floe.run` debug extension event? */
export function callerWantsDebugRunEvent(req: Request): boolean {
	return req.headers.get('x-floe-debug-events') === '1';
}
