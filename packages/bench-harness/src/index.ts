/**
 * `runBench(config)` — single-call live-server bench harness.
 *
 * For each model: spawn the example's server with `FLOE_MODEL=<id>` in
 * the env, run every scenario sequentially (multi-turn supported),
 * assert each turn, stop the server. Aggregate per-model results
 * into a `BenchReport`, format the console matrix, and persist JSON.
 *
 * Replaces the 300-650 LOC bench scaffolding three example files used
 * to carry: subprocess lifecycle, SSE parsing, percentile math, pass
 * matrix, JSON write. Callers now write scenarios + assertions only.
 */
import { resolve as resolvePath } from 'node:path';
import type { Assertion, AssertionContext } from '@floe/runtime/eval';
import { startServer, type ServerSpec } from './server-runner.ts';
import { send } from './transport.ts';
import { formatFullReport, writeJsonReport } from './reporter.ts';
import type {
	BenchModel,
	BenchScenario,
	BenchReport,
	ModelBenchReport,
	ScenarioRunResult,
	TurnRunResult,
} from './types.ts';

export interface BenchConfig {
	/**
	 * Working directory for the server subprocess. The harness `cd`s
	 * here before spawning. Typically the example's root.
	 */
	cwd: string;
	/** Models to sweep. Strings get default `thinking: 'off'`. */
	models: Array<BenchModel | string>;
	/** Scenarios run per model. Each scenario gets a fresh session id. */
	scenarios: BenchScenario[];
	/**
	 * Override the server-spawn shape. Defaults: port `3593` (collision-
	 * unlikely), `['npx', 'tsx', 'server.ts']`, ready-probe on `/`.
	 */
	server?: Omit<ServerSpec, 'env' | 'cwd'> | false;
	/**
	 * Pre-warm with one throwaway scenario turn to amortize cold-start
	 * (vector store load, embedder init, knowledge walk). Default `true`.
	 */
	warmup?: boolean | string;
	/**
	 * Write the report JSON here. Defaults to `${cwd}/test/__bench_run.json`.
	 * Pass `false` to skip disk write.
	 */
	reportPath?: string | false;
	/**
	 * If `false`, suppress the console matrix. Default `true`.
	 */
	printConsoleReport?: boolean;
	/**
	 * Concurrency for scenarios within a model. Default `'serial'`
	 * (preserves deterministic TTFT + rate-limit safety).
	 */
	concurrency?: 'serial' | { perModel: number };
}

export interface RunBenchResult {
	report: BenchReport;
	/** `true` if every scenario × every model passed. */
	ok: boolean;
}

export async function runBench(cfg: BenchConfig): Promise<RunBenchResult> {
	const startedAt = Date.now();
	const normalizedModels: BenchModel[] = cfg.models.map((m) =>
		typeof m === 'string' ? { id: m, label: shortLabel(m), thinking: 'off' } : { ...m, label: m.label ?? shortLabel(m.id) },
	);

	const modelReports: ModelBenchReport[] = [];

	const useExternalServer = cfg.server === false;
	const serverOverrides: Omit<ServerSpec, 'env' | 'cwd'> =
		useExternalServer || !cfg.server ? { port: 3593 } : cfg.server;

	for (const model of normalizedModels) {
		const modelStart = Date.now();
		const serverSpec: ServerSpec = {
			...serverOverrides,
			cwd: cfg.cwd,
			env: {
				FLOE_MODEL: model.id,
				...(model.thinking ? { FLOE_THINKING: model.thinking } : {}),
				...(model.env ?? {}),
			},
		};

		const handle = useExternalServer ? null : await startServer(serverSpec);
		const baseUrl = handle?.baseUrl ?? `http://localhost:${serverSpec.port}`;

		try {
			if (cfg.warmup !== false) {
				const msg = typeof cfg.warmup === 'string' ? cfg.warmup : 'hello';
				try {
					await send({ baseUrl, sessionId: `warmup-${model.label}-${Date.now()}`, message: msg });
				} catch {
					// warmup failures shouldn't abort the model run.
				}
			}

			const scenarios: ScenarioRunResult[] = [];
			for (const scenario of cfg.scenarios) {
				const result = await runOneScenario(scenario, model.label!, baseUrl);
				scenarios.push(result);
			}

			modelReports.push({
				label: model.label!,
				id: model.id,
				scenarios,
				durationMs: Date.now() - modelStart,
			});
		} finally {
			if (handle) await handle.stop();
		}
	}

	const report: BenchReport = {
		ranAt: new Date().toISOString(),
		durationMs: Date.now() - startedAt,
		models: modelReports,
		scenarios: cfg.scenarios.map((s) => ({
			id: s.id,
			...(s.description ? { description: s.description } : {}),
			firstUserMessage: s.turns[0]?.userMessage ?? '',
		})),
	};

	if (cfg.printConsoleReport !== false) {
		console.log(formatFullReport(report));
	}

	if (cfg.reportPath !== false) {
		const path = cfg.reportPath ?? resolvePath(cfg.cwd, 'test', '__bench_run.json');
		await writeJsonReport(path, report);
		console.log(`\nSaved raw: ${path}`);
	}

	const ok = report.models.every((m) => m.scenarios.every((s) => s.pass));
	return { report, ok };
}

async function runOneScenario(
	scenario: BenchScenario,
	modelLabel: string,
	baseUrl: string,
): Promise<ScenarioRunResult> {
	const sessionId = `${scenario.sessionPrefix ?? scenario.id}-${slug(modelLabel)}-${Date.now()}`;
	const turnsOut: TurnRunResult[] = [];
	const allTexts: string[] = [];
	const allEvents: typeof turnsOut[number]['events'] = [];
	let lastState: TurnRunResult['state'] = undefined;
	let pass = true;
	const start = Date.now();

	for (let i = 0; i < scenario.turns.length; i++) {
		const turn = scenario.turns[i]!;
		const sid = turn.userId ? `${sessionId}-${turn.userId}` : sessionId;
		let response;
		try {
			response = await send({
				baseUrl,
				sessionId: sid,
				message: turn.userMessage,
				...(turn.userId ? { userId: turn.userId } : {}),
			});
		} catch (err) {
			turnsOut.push({
				turnIndex: i,
				userMessage: turn.userMessage,
				assistantText: '',
				ttftMs: null,
				endToEndMs: 0,
				events: [],
				state: undefined,
				assertions: [
					{
						name: 'request_succeeded',
						pass: false,
						message: err instanceof Error ? err.message : String(err),
					},
				],
			});
			pass = false;
			continue;
		}

		allTexts.push(response.text);
		allEvents.push(...response.events);
		lastState = response.state;

		const ctx: AssertionContext = {
			text: response.text,
			allTexts,
			events: allEvents,
			state: lastState!,
			metrics: [],
		};

		const assertResults = await Promise.all(
			turn.expect.map(async (a) => assertOne(a, ctx)),
		);
		const allPassed = assertResults.every((r) => r.pass);
		if (!allPassed) pass = false;

		turnsOut.push({
			turnIndex: i,
			userMessage: turn.userMessage,
			assistantText: response.text,
			ttftMs: response.ttftMs,
			endToEndMs: response.endToEndMs,
			events: response.events,
			state: response.state,
			assertions: assertResults,
		});
	}

	return {
		scenarioId: scenario.id,
		turns: turnsOut,
		pass,
		totalLatencyMs: Date.now() - start,
	};
}

async function assertOne(
	a: Assertion,
	ctx: AssertionContext,
): Promise<{ name: string; pass: boolean; message?: string }> {
	try {
		const res = await a.check(ctx);
		return {
			name: a.name,
			pass: res.pass,
			...(res.message ? { message: res.message } : {}),
		};
	} catch (err) {
		return {
			name: a.name,
			pass: false,
			message: err instanceof Error ? err.message : String(err),
		};
	}
}

function shortLabel(id: string): string {
	const slash = id.lastIndexOf('/');
	return slash >= 0 ? id.slice(slash + 1) : id;
}

function slug(s: string): string {
	return s.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

export { startServer } from './server-runner.ts';
export { send } from './transport.ts';
export { percentile, summarize } from './percentile.ts';
export { openAiJudge } from './judges.ts';
export {
	formatFullReport,
	formatPassMatrix,
	formatLatencyTable,
	formatPassRate,
	formatSampleReplies,
	writeJsonReport,
} from './reporter.ts';
export type {
	BenchModel,
	BenchScenario,
	BenchTurn,
	BenchReport,
	ModelBenchReport,
	ScenarioRunResult,
	TurnRunResult,
} from './types.ts';
