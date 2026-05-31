/**
 * Faux LLM provider — zero-cost regression testing.
 *
 * Wraps Pi's `registerFauxProvider` + Flue's `registerProvider` so a
 * single Floe-blessed call registers a deterministic fake LLM addressable
 * as `model: 'faux/<modelId>'`. Each `session.prompt()` consumes one
 * scripted response from the queue (FIFO), so tests can assert exact
 * tool-call sequences, branching decisions, and orchestrator wire shape
 * WITHOUT paying for real LLM calls.
 *
 * Different from semantic assertions in the eval framework: this is for
 * STRUCTURAL behavior (does the orchestrator route to the right node?
 * does the mux emit the right chunks? do flow transitions fire?). Real
 * LLM behavior testing belongs in the semantic-assertion bench.
 *
 * @example
 *   import { registerFloeFaux, fauxAssistantMessage } from '@floe/runtime/testing';
 *
 *   const faux = registerFloeFaux({
 *     responses: [
 *       fauxAssistantMessage('Hi! How can I help?'),
 *       fauxAssistantMessage('You said: hello'),
 *     ],
 *   });
 *   const assistant = new Assistant({ model: 'faux/test', ... });
 *   try {
 *     // Run your test scenarios — each session.prompt consumes one response
 *   } finally {
 *     faux.unregister();
 *   }
 */
import {
	registerFauxProvider,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type FauxResponseStep,
	type FauxResponseFactory,
	type FauxModelDefinition,
} from '@earendil-works/pi-ai';
import { registerProvider } from '@flue/runtime/app';

export interface FloeFauxOptions {
	/**
	 * Flue/Pi provider slug. Address models as `model: '<provider>/<modelId>'`.
	 * Default `'faux'`. Use a unique slug per test if you need parallel
	 * registrations.
	 */
	provider?: string;
	/**
	 * Models to expose. Default `[{id: 'test'}]`. The first model is the
	 * default if a request addresses the provider without a specific id.
	 */
	models?: FauxModelDefinition[];
	/**
	 * Scripted response sequence. Each `session.prompt()` consumes one
	 * step FIFO. A step can be:
	 *   - A static `AssistantMessage` (built via `fauxAssistantMessage(...)`)
	 *   - A factory `(ctx, opts, state) => AssistantMessage` that inspects
	 *     the request context (messages, tools) and returns a dynamic
	 *     response. Use for behavior that depends on what was sent.
	 *
	 * Pass `[]` to start empty and use `setResponses` / `appendResponses`
	 * later (useful for interactive tests).
	 */
	responses: FauxResponseStep[];
	/**
	 * Simulated token streaming rate. Default ~200 tokens/sec. Lower values
	 * simulate slow models (useful for testing timeout / interruption
	 * paths); higher values run tests faster.
	 */
	tokensPerSecond?: number;
}

export interface FloeFauxHandle {
	/** Provider slug this registration uses (echoed from options or default). */
	readonly provider: string;
	/** Reset the response queue to a new sequence (drops any pending). */
	setResponses(responses: FauxResponseStep[]): void;
	/** Append more responses to the back of the queue. */
	appendResponses(responses: FauxResponseStep[]): void;
	/** How many scripted responses are still queued (not yet consumed). */
	getPending(): number;
	/** How many `session.prompt()` calls this faux has served. */
	callCount(): number;
	/**
	 * Tear down the registration. Always call from `afterEach` /
	 * `afterAll` to avoid leaking the faux into other tests. The
	 * provider slug becomes reusable for re-registration.
	 */
	unregister(): void;
}

const DEFAULT_PROVIDER = 'faux';

export function registerFloeFaux(opts: FloeFauxOptions): FloeFauxHandle {
	const provider = opts.provider ?? DEFAULT_PROVIDER;

	// Pi-level registration: registers the `faux` api handler + the
	// model catalog entries the provider exposes.
	const piReg = registerFauxProvider({
		api: 'faux',
		provider,
		models: opts.models ?? [{ id: 'test' }],
		...(opts.tokensPerSecond !== undefined ? { tokensPerSecond: opts.tokensPerSecond } : {}),
	});
	piReg.setResponses(opts.responses);

	// Flue-level registration: aliases the provider slug → api so Flue's
	// model resolver can route `'faux/test'` to Pi's faux handler.
	// `baseUrl` is required by the type but ignored by faux (no real HTTP).
	// `registerProvider` is last-write-wins — safe to re-register; if a
	// previous test left a registration around, we just overwrite it.
	registerProvider(provider, {
		api: 'faux',
		baseUrl: 'http://faux.invalid',
	});

	return {
		provider,
		setResponses: (r) => piReg.setResponses(r),
		appendResponses: (r) => piReg.appendResponses(r),
		getPending: () => piReg.getPendingResponseCount(),
		callCount: () => piReg.state.callCount,
		unregister: () => piReg.unregister(),
	};
}

// Re-export Pi's response builders so users don't need a second import.
export {
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
};
export type {
	FauxResponseStep,
	FauxResponseFactory,
	FauxModelDefinition,
};
