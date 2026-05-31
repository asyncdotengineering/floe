/**
 * Internal entrypoint — for Floe adapter packages only (e.g.
 * `@floe/adapter-web`, `@floe/adapter-slack`). Application code should
 * never import from `@floe/runtime/internal`. The exports here have no
 * stability guarantee.
 */
export { createFloeApp } from './create-floe-app.ts';
export type { CreateFloeAppOptions, FloeApp, FloeRouter } from './create-floe-app.ts';
export { Floe } from './floe.ts';
export type { FlueAgentHandler, HandlerOptions } from './floe.ts';
export { webChannel } from './web-channel.ts';
export {
	streamAsOpenAISSE,
	bufferAsOpenAIJson,
	newCompletionId,
	callerWantsBufferedJson,
	callerWantsDebugRunEvent,
	type OpenAIChunkContext,
} from './streaming/index.ts';
