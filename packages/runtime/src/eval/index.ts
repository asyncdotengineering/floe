/** Identity helper for type inference. */
import type { Scenario } from './types.ts';

export function defineScenario(s: Scenario): Scenario {
	return s;
}

export {
	contains,
	notContains,
	matches,
	enteredFlow,
	noFlowEntered,
	mentionsNode,
	costBelow,
	latencyBelow,
	llmJudge,
} from './assertions.ts';
export type { LlmJudgeOptions } from './assertions.ts';

export {
	semanticContains,
	semanticNotContains,
	semanticMatches,
} from './semantic.ts';
export type { SemanticOptions, JudgeFn, JudgeVerdict } from './semantic.ts';

export { runScenarios, runScenariosOverHttp } from './runner.ts';
export type { RunOptions, HttpRunOptions } from './runner.ts';

export { saveBaseline, loadBaseline, diffAgainstBaseline, formatDiff } from './baseline.ts';

export type {
	Assertion,
	AssertionContext,
	AssertionResult,
	BaselineDiff,
	RunReport,
	Scenario,
	ScenarioInput,
	ScenarioRunResult,
	ScenarioStep,
} from './types.ts';
