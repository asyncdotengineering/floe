import type { Assertion, AssertionContext } from '@floe/runtime/eval';
import type { AssistantOutputEvent, AssistantState } from '@floe/runtime';

export interface BenchModel {
	id: string;
	label?: string;
	/** Optional `thinkingLevel` hint surfaced to the example via env. Default `off`. */
	thinking?: 'off' | 'low' | 'medium' | 'high';
	/** Extra env vars piped to the server subprocess. */
	env?: Record<string, string>;
}

export interface BenchTurn {
	userMessage: string;
	userId?: string;
	expect: Assertion[];
}

export interface BenchScenario {
	id: string;
	description?: string;
	turns: BenchTurn[];
	/** Optional session id prefix. Defaults to `id`. */
	sessionPrefix?: string;
}

export interface TurnRunResult {
	turnIndex: number;
	userMessage: string;
	assistantText: string;
	ttftMs: number | null;
	endToEndMs: number;
	events: AssistantOutputEvent[];
	state: AssistantState | undefined;
	assertions: Array<{ name: string; pass: boolean; message?: string }>;
}

export interface ScenarioRunResult {
	scenarioId: string;
	turns: TurnRunResult[];
	pass: boolean;
	totalLatencyMs: number;
	error?: string;
}

export interface ModelBenchReport {
	label: string;
	id: string;
	scenarios: ScenarioRunResult[];
	durationMs: number;
}

export interface BenchReport {
	ranAt: string;
	durationMs: number;
	models: ModelBenchReport[];
	scenarios: Array<{ id: string; description?: string; firstUserMessage: string }>;
}

export type { Assertion, AssertionContext };
