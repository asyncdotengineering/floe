/**
 * Scenario runner. Drives a Floe instance against each scenario, then
 * runs the scenario's assertions over the captured outcome.
 *
 * Concurrency: scenarios run sequentially by default (predictable
 * billing/latency). Pass `concurrency: N` to fan out.
 */
import type { Floe } from '../floe.ts';
import type { AssistantOutputEvent, AssistantState } from '../types.ts';
import type { TurnMetrics } from '../observability/types.ts';
import type { Scenario, ScenarioRunResult, RunReport } from './types.ts';

export interface RunOptions {
	floe: Floe;
	scenarios: Scenario[];
	/** Max parallel scenarios. Default 1. */
	concurrency?: number;
	/** Hook fires after each scenario — useful for live reporters. */
	onScenarioComplete?: (result: ScenarioRunResult) => void;
}

/**
 * In-process scenario driver. Calls the Floe handler directly (no HTTP
 * server) by simulating the FlueContext that the handler expects.
 *
 * Limitations: this stub does NOT actually run the Floe orchestrator
 * with a real Flue Session — `runAssistantTurn` requires a live
 * `ctx.init()` returning a `FlueHarness`, which only Flue's runtime
 * provides. For now the runner only supports scenarios that go through
 * a real Floe HTTP deployment. The `liveRunner` adapter below issues
 * actual HTTP calls so a Floe `flue dev` server can be exercised.
 *
 * If your tests should run without spinning up a server, see the
 * `examples/streaming-bot/test/live.test.ts` pattern: spawn the server
 * once, fire requests, parse responses. The Scenario type composes well
 * with that pattern.
 */
export async function runScenarios(opts: RunOptions): Promise<RunReport> {
	const concurrency = Math.max(1, opts.concurrency ?? 1);
	const results: ScenarioRunResult[] = [];
	const queue = [...opts.scenarios];
	const inFlight = new Set<Promise<void>>();
	while (queue.length > 0 || inFlight.size > 0) {
		while (inFlight.size < concurrency && queue.length > 0) {
			const scenario = queue.shift()!;
			const p = runOneScenario(opts.floe, scenario)
				.then((res) => {
					results.push(res);
					opts.onScenarioComplete?.(res);
				})
				.finally(() => {
					inFlight.delete(p);
				});
			inFlight.add(p);
		}
		if (inFlight.size > 0) await Promise.race(inFlight);
	}
	results.sort((a, b) => a.scenarioId.localeCompare(b.scenarioId));
	const passed = results.filter((r) => r.pass).length;
	return {
		ranAt: new Date().toISOString(),
		totalScenarios: results.length,
		passed,
		failed: results.length - passed,
		results,
	};
}

async function runOneScenario(floe: Floe, scenario: Scenario): Promise<ScenarioRunResult> {
	const start = Date.now();
	const steps = Array.isArray(scenario.when) ? scenario.when : [scenario.when];

	const allTexts: string[] = [];
	const events: AssistantOutputEvent[] = [];
	const metrics: TurnMetrics[] = [];
	let lastState: AssistantState | null = null;
	let error: string | undefined;

	// Buffer metrics from this scenario so assertions can read them.
	const captureSink = {
		name: 'eval-capture',
		record(m: TurnMetrics): void {
			metrics.push(m);
		},
	};
	const existingObservability = floe.config.defaults.observability;
	(floe.config.defaults as { observability?: typeof existingObservability }).observability = {
		...(existingObservability ?? {}),
		awaitSinks: true,
		sinks: [...(existingObservability?.sinks ?? []), captureSink],
	};

	try {
		for (const step of steps) {
			const result = await invokeOnce(floe, scenario, step);
			allTexts.push(result.text);
			events.push(...result.events);
			lastState = result.state;
		}
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	} finally {
		// Restore prior observability config.
		if (existingObservability === undefined) {
			delete (floe.config.defaults as { observability?: typeof existingObservability }).observability;
		} else {
			(floe.config.defaults as { observability?: typeof existingObservability }).observability =
				existingObservability;
		}
	}

	const ctx = {
		text: allTexts[allTexts.length - 1] ?? '',
		allTexts,
		events,
		state: lastState ?? emptyState(scenario.given.conversation ?? 'unknown'),
		metrics,
	};
	const checked: { name: string; result: { pass: boolean; message?: string; details?: Record<string, unknown> } }[] = [];
	let overallPass = !error;
	if (!error) {
		for (const assertion of scenario.expect) {
			try {
				const r = await assertion.check(ctx);
				checked.push({ name: assertion.name, result: r });
				if (!r.pass) overallPass = false;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				checked.push({ name: assertion.name, result: { pass: false, message: `assertion threw: ${message}` } });
				overallPass = false;
			}
		}
	}
	return {
		scenarioId: scenario.id,
		pass: overallPass,
		assertions: checked,
		finalText: ctx.text,
		allTexts,
		state: ctx.state,
		metrics,
		...(scenario.tags ? { tags: scenario.tags } : {}),
		...(error ? { error } : {}),
		durationMs: Date.now() - start,
	};
}

/**
 * Direct in-process invocation isn't possible because the Floe handler
 * needs a real Flue `FlueContext`. The runner therefore expects callers
 * to provide their own `invoke` callback OR to use `runScenariosOverHttp`
 * (below). For typed-Flue invocation, see the `flueAgentSdk` pattern in
 * docs.
 */
async function invokeOnce(
	_floe: Floe,
	scenario: Scenario,
	_step: { userMessage: string },
): Promise<{ text: string; events: AssistantOutputEvent[]; state: AssistantState }> {
	throw new Error(
		`[eval] Scenario "${scenario.id}" requires an HTTP runner. Use \`runScenariosOverHttp({ scenarios, baseUrl, ... })\` or supply a custom invoker. In-process direct invocation is reserved for a future Floe SDK that wraps Flue's createAgentSession.`,
	);
}

function emptyState(conversation: string): AssistantState {
	return {
		version: 1,
		assistantName: conversation,
		channelName: 'http',
		startedAt: new Date().toISOString(),
		turnCount: 0,
		activeFlow: null,
		activeProcedures: [],
		pendingTransition: null,
		metrics: {
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalCostUsd: 0,
			lastTurnLatencyMs: 0,
			interruptionCount: 0,
		},
	};
}

// ─── HTTP runner ──────────────────────────────────────────────────────────

export interface HttpRunOptions {
	scenarios: Scenario[];
	/** Floe server base URL — e.g. http://localhost:3593 */
	baseUrl: string;
	/** Path to POST messages to. Default `/agents/web/<sessionId>`. */
	agentPath?: string;
	/** Concurrency. Default 1. */
	concurrency?: number;
	onScenarioComplete?: (result: ScenarioRunResult) => void;
	fetch?: typeof fetch;
}

/**
 * HTTP-shaped runner. Drives a running Floe server (e.g. one started by
 * `flue dev` or the OpenAI-compat handler) via its standard POST endpoint.
 * This is the production-shaped path — same wire format Floe handles in
 * real traffic.
 */
export async function runScenariosOverHttp(opts: HttpRunOptions): Promise<RunReport> {
	const concurrency = Math.max(1, opts.concurrency ?? 1);
	const fetchFn = opts.fetch ?? fetch;
	const agentPath = opts.agentPath ?? '/agents/web';
	const results: ScenarioRunResult[] = [];
	const queue = [...opts.scenarios];
	const inFlight = new Set<Promise<void>>();
	while (queue.length > 0 || inFlight.size > 0) {
		while (inFlight.size < concurrency && queue.length > 0) {
			const scenario = queue.shift()!;
			const p = runOneOverHttp(scenario, opts.baseUrl, agentPath, fetchFn)
				.then((res) => {
					results.push(res);
					opts.onScenarioComplete?.(res);
				})
				.finally(() => {
					inFlight.delete(p);
				});
			inFlight.add(p);
		}
		if (inFlight.size > 0) await Promise.race(inFlight);
	}
	results.sort((a, b) => a.scenarioId.localeCompare(b.scenarioId));
	const passed = results.filter((r) => r.pass).length;
	return {
		ranAt: new Date().toISOString(),
		totalScenarios: results.length,
		passed,
		failed: results.length - passed,
		results,
	};
}

async function runOneOverHttp(
	scenario: Scenario,
	baseUrl: string,
	agentPath: string,
	fetchFn: typeof fetch,
): Promise<ScenarioRunResult> {
	const start = Date.now();
	const steps = Array.isArray(scenario.when) ? scenario.when : [scenario.when];
	const allTexts: string[] = [];
	const events: AssistantOutputEvent[] = [];
	let lastState: AssistantState | null = null;
	let error: string | undefined;

	try {
		for (const step of steps) {
			const url = `${baseUrl.replace(/\/+$/, '')}${agentPath}/${scenario.given.sessionId}`;
			const body = {
				message: step.userMessage,
				...(scenario.given.metadata ? { metadata: scenario.given.metadata } : {}),
				...(scenario.given.conversation ? { assistantName: scenario.given.conversation } : {}),
			};
			const r = await fetchFn(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
			if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
			const parsed = (await r.json()) as {
				result: {
					text: string;
					events: AssistantOutputEvent[];
					state?: AssistantState;
				};
			};
			allTexts.push(parsed.result.text);
			events.push(...(parsed.result.events ?? []));
			if (parsed.result.state) lastState = parsed.result.state;
		}
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	}

	const ctx = {
		text: allTexts[allTexts.length - 1] ?? '',
		allTexts,
		events,
		state: lastState ?? emptyState(scenario.given.conversation ?? 'unknown'),
		metrics: [], // HTTP boundary doesn't expose per-turn metrics directly today
	};
	const checked: { name: string; result: { pass: boolean; message?: string; details?: Record<string, unknown> } }[] = [];
	let overallPass = !error;
	if (!error) {
		for (const assertion of scenario.expect) {
			try {
				const r = await assertion.check(ctx);
				checked.push({ name: assertion.name, result: r });
				if (!r.pass) overallPass = false;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				checked.push({ name: assertion.name, result: { pass: false, message: `assertion threw: ${message}` } });
				overallPass = false;
			}
		}
	}
	return {
		scenarioId: scenario.id,
		pass: overallPass,
		assertions: checked,
		finalText: ctx.text,
		allTexts,
		state: ctx.state,
		metrics: [],
		...(scenario.tags ? { tags: scenario.tags } : {}),
		...(error ? { error } : {}),
		durationMs: Date.now() - start,
	};
}
