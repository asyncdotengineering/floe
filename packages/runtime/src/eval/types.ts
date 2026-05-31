/**
 * Eval framework — declarative scenarios + asserted outcomes.
 *
 * Mental model:
 *   - A `Scenario` is a deterministic recipe: "given this state, when the
 *     user says this, expect these assertions to pass."
 *   - The runner drives a `Floe` instance once per scenario, captures the
 *     `TurnResult` + emitted events, and runs each `Assertion` against
 *     them.
 *   - A run produces a `RunReport` which can be diffed against a saved
 *     `BaselineReport` to spot regressions.
 */
import type { AssistantOutputEvent, AssistantState } from '../types.ts';
import type { TurnMetrics } from '../observability/types.ts';

export interface ScenarioInput {
	/** Conversation name. Defaults to first registered. */
	conversation?: string;
	/** Stable instance id (so multi-turn scenarios reuse session state). */
	sessionId: string;
	/** Optional inbound metadata (userId, headers proxy, etc.). */
	metadata?: Record<string, unknown>;
}

export interface ScenarioStep {
	userMessage: string;
}

export interface Scenario {
	id: string;
	description?: string;
	given: ScenarioInput;
	/** One or more user messages. Single-turn scenarios pass an array of length 1. */
	when: ScenarioStep | ScenarioStep[];
	expect: Assertion[];
	/** Optional tags for filtering / grouping in reports. */
	tags?: string[];
}

export interface AssertionContext {
	/** The final assistant text from the LAST turn of this scenario. */
	text: string;
	/** All assistant text turns in order (multi-step scenarios). */
	allTexts: string[];
	/** Full event stream of every turn in this scenario. */
	events: AssistantOutputEvent[];
	/** Final AssistantState after the scenario. */
	state: AssistantState;
	/** TurnMetrics from each turn (only present when the floe instance had an observability sink that buffered). */
	metrics: TurnMetrics[];
}

export interface AssertionResult {
	pass: boolean;
	/** Short human-readable reason on failure. */
	message?: string;
	/** Optional details (regex match, captured fragment, etc.). */
	details?: Record<string, unknown>;
}

export interface Assertion {
	readonly name: string;
	check(ctx: AssertionContext): Promise<AssertionResult> | AssertionResult;
}

export interface ScenarioRunResult {
	scenarioId: string;
	pass: boolean;
	assertions: Array<{ name: string; result: AssertionResult }>;
	finalText: string;
	allTexts: string[];
	state: AssistantState;
	metrics: TurnMetrics[];
	tags?: string[];
	error?: string;
	durationMs: number;
}

export interface RunReport {
	ranAt: string;
	totalScenarios: number;
	passed: number;
	failed: number;
	results: ScenarioRunResult[];
}

export interface BaselineDiff {
	regressions: ScenarioRunResult[];
	improvements: ScenarioRunResult[];
	newScenarios: ScenarioRunResult[];
	removedScenarios: string[];
}
