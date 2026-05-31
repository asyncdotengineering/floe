/**
 * The spine. Re-exports from orchestrator/ sub-modules.
 *
 * Per REFACTOR-FIN-HARNESS §6 (C-7): the 1,079-LOC monolith was extracted
 * into four composable stages under orchestrator/:
 *   prepareTurn → retrieve → respond → finalizeTurn
 *
 * This file preserves the original public surface (RunTurnArgs, TurnResult,
 * runAssistantTurn) so existing callers (floe.ts) don't change.
 */
export {
	runAssistantTurn,
	type RunTurnArgs,
	type TurnResult,
} from './orchestrator/index.ts';
