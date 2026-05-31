/**
 * Validator chain execution. Three phases:
 *   - preLLM           — runs before the LLM call; can block (return non-ok)
 *   - postLLM          — runs after the LLM call (sync); can rewrite/retry/escalate
 *   - postLLM-async    — runs after the response is dispatched; fire-and-observe
 */
import type { FlueSession } from '@flue/runtime';
import type {
	AssistantState,
	TurnUnderReview,
	ValidationResult,
	Validator,
} from './types.ts';

export interface ValidatorRunResult {
	/** First TERMINAL non-ok result (retry/escalate/disambiguate). `{ok:true}` if everything passed (rewrites still chain). */
	verdict: ValidationResult;
	/** All non-ok results, in order (includes terminal failures AND rewrites). */
	failures: { validator: string; result: ValidationResult }[];
	/**
	 * The (possibly rewritten) turn after chained `rewrite` validators
	 * applied their changes. Equal to the input `turn` when no rewrites
	 * occurred. The orchestrator should use THIS turn for subsequent
	 * stages (e.g., the LLM call after a preLLM rewrite, the wire emission
	 * after a postLLM rewrite).
	 */
	turn: TurnUnderReview;
}

function inScope(
	validator: Validator,
	args: { assistantName: string; flowName: string | null; channelName: string },
): boolean {
	const scope = validator.scope;
	if (!scope) return true;
	if (false /* role-based scoping; v1 no-op */) return false;
	if (scope.flows && args.flowName && !scope.flows.includes(args.flowName)) return false;
	if (scope.channels && !scope.channels.includes(args.channelName)) return false;
	return true;
}

export async function runValidatorPhase(args: {
	validators: Validator[];
	phase: Validator['phase'];
	turn: TurnUnderReview;
	session: FlueSession;
	state: AssistantState;
	assistantName: string;
	flowName: string | null;
	channelName: string;
}): Promise<ValidatorRunResult> {
	const failures: { validator: string; result: ValidationResult }[] = [];
	const eligible = args.validators.filter(
		(v) =>
			v.phase === args.phase &&
			inScope(v, {
				assistantName: args.assistantName,
				flowName: args.flowName,
				channelName: args.channelName,
			}),
	);

	// The turn mutates as `rewrite` validators chain. We make ONE shallow
	// copy and rewrite the appropriate field in place.
	let workingTurn: TurnUnderReview = { ...args.turn };

	for (const v of eligible) {
		const result = await v.validate(workingTurn, {
			session: args.session,
			state: args.state,
		});
		if ('ok' in result && result.ok === true) continue;
		// Chained rewrites: apply and keep going. PII redaction relies on this.
		if ('rewrite' in result) {
			failures.push({ validator: v.name, result });
			if (args.phase === 'preLLM') {
				workingTurn = { ...workingTurn, userMessage: result.rewrite };
			} else {
				workingTurn = { ...workingTurn, assistantText: result.rewrite };
			}
			continue;
		}
		// Terminal failures (retry / escalate / disambiguate): record and stop
		// for sync phases. Async phases (postLLM-async) keep going so the sink
		// sees every validator's verdict.
		failures.push({ validator: v.name, result });
		if (args.phase !== 'postLLM-async') {
			return { verdict: result, failures, turn: workingTurn };
		}
	}
	return { verdict: { ok: true }, failures, turn: workingTurn };
}

/**
 * Fire all postLLM-async validators in parallel without awaiting. Their
 * results can be observed via the supplied sink. Used to update next-turn
 * state without blocking the wire.
 */
export function fireAsyncValidators(args: {
	validators: Validator[];
	turn: TurnUnderReview;
	session: FlueSession;
	state: AssistantState;
	assistantName: string;
	flowName: string | null;
	channelName: string;
	sink: (validator: string, result: ValidationResult) => void;
}): void {
	const eligible = args.validators.filter(
		(v) =>
			v.phase === 'postLLM-async' &&
			inScope(v, {
				assistantName: args.assistantName,
				flowName: args.flowName,
				channelName: args.channelName,
			}),
	);
	for (const v of eligible) {
		Promise.resolve(v.validate(args.turn, { session: args.session, state: args.state }))
			.then((result) => args.sink(v.name, result))
			.catch((err) => {
				args.sink(v.name, {
					escalate: {
						reason: `async validator ${v.name} threw: ${err instanceof Error ? err.message : String(err)}`,
					},
				});
			});
	}
}
