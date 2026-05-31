/**
 * ValidatorCoordinator — single boundary for the three validator phases.
 *
 * Replaces three independent callsites in `respond.ts` (preLLM /
 * postLLM-sync / postLLM-async) that each duplicated:
 *
 *   - the same six-field scope context (assistantName, flowName,
 *     channelName, session, state, validators)
 *   - the same "filter validators by phase" pattern
 *   - DIFFERENT post-result handling that mixed `result.turn` with the
 *     original turn in non-obvious ways
 *
 * The coordinator owns the immutable contract: caller passes the turn
 * IN, gets the (possibly rewritten) turn OUT. There's no "original
 * turn lying around to confuse with the validated one" — the caller
 * uses the returned `turn` for every subsequent operation. The compiler
 * enforces it because the original is shadowed by the destructured
 * return.
 *
 * The coordinator is created once per turn (in respond.ts) — it
 * captures the per-turn scope (assistantName, flowName, channelName,
 * session, state) so callsites don't re-thread these on every phase.
 */
import type { FlueSession } from '@flue/runtime';
import type {
	AssistantOutputEvent,
	AssistantState,
	TurnUnderReview,
	ValidationResult,
	Validator,
} from './types.ts';
import {
	runValidatorPhase,
	fireAsyncValidators,
	type ValidatorRunResult,
} from './validators-run.ts';

/**
 * Per-turn scope captured at coordinator creation time. Everything
 * downstream uses these values — callsites don't re-pass them.
 */
export interface ValidatorScope {
	validators: Validator[];
	session: FlueSession;
	state: AssistantState;
	assistantName: string;
	flowName: string | null;
	channelName: string;
}

/**
 * Result of a sync phase run. `verdict` is `{ok:true}` when every
 * applicable validator passed; otherwise a non-ok terminal verdict
 * (retry / escalate / disambiguate). `turn` is the (possibly rewritten)
 * turn the caller MUST use for subsequent stages.
 */
export type ValidatorPhaseResult = ValidatorRunResult;

export interface ValidatorCoordinator {
	/**
	 * Run the sync `preLLM` phase. Caller MUST use the returned turn
	 * for the LLM call (preLLM rewrites mutate userMessage).
	 */
	preLLM(turn: TurnUnderReview): Promise<ValidatorPhaseResult>;
	/**
	 * Run the sync `postLLM` phase. Caller MUST use the returned turn
	 * for wire emission (postLLM rewrites mutate assistantText).
	 */
	postLLM(turn: TurnUnderReview): Promise<ValidatorPhaseResult>;
	/**
	 * Fire the `postLLM-async` phase. Returns immediately; validators
	 * run in the background. Results are surfaced via `onResult` (one
	 * per validator) — typically wired to emit a `validator_result`
	 * conversation_event on the wire for observability.
	 */
	postLLMAsync(turn: TurnUnderReview, onResult: ValidatorResultSink): void;
}

/**
 * Sink the coordinator calls for each async validator's result. The
 * caller decides what to do with it (emit an event, log, push to
 * observability, etc.). This is a function, not an EventEmitter, to
 * keep the coordinator's contract synchronous + testable.
 */
export type ValidatorResultSink = (validator: string, result: ValidationResult) => void;

/**
 * Construct a coordinator for one turn. Captures the scope; callsites
 * use the returned methods without re-passing the scope on each call.
 */
export function createValidatorCoordinator(scope: ValidatorScope): ValidatorCoordinator {
	const baseScopeArgs = {
		validators: scope.validators,
		session: scope.session,
		state: scope.state,
		assistantName: scope.assistantName,
		flowName: scope.flowName,
		channelName: scope.channelName,
	};
	return {
		async preLLM(turn) {
			return runValidatorPhase({ ...baseScopeArgs, phase: 'preLLM', turn });
		},
		async postLLM(turn) {
			return runValidatorPhase({ ...baseScopeArgs, phase: 'postLLM', turn });
		},
		postLLMAsync(turn, onResult) {
			fireAsyncValidators({
				...baseScopeArgs,
				turn,
				sink: onResult,
			});
		},
	};
}

/**
 * Convenience helper that builds the standard observability sink for
 * postLLM-async results — emits a `conversation_event:validator_result`
 * onto the events list. Use from respond.ts so the wire surfaces
 * async-validator verdicts consistently.
 */
export function createValidatorResultEventSink(args: {
	events: AssistantOutputEvent[];
	respondingTo: string;
}): ValidatorResultSink {
	return (validator, result) => {
		args.events.push({
			type: 'conversation_event',
			subtype: 'validator_result',
			data: { validator, phase: 'postLLM-async', result },
			respondingTo: args.respondingTo,
		});
	};
}
