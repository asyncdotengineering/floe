/**
 * Benchmark for the AriaFlow competitor. Same shape as Floe's bench so the
 * two outputs are directly comparable.
 *
 * One fresh server process per model (BENCH_MODEL env), with one warm-up
 * call before the timed iterations.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cwd = resolve(__dirname, '..');
const PORT = 3597;
const BASE = `http://localhost:${PORT}`;
const N = Number(process.env.BENCH_N ?? '5');

const HAS_OPENAI = !!process.env.OPENAI_API_KEY;
const HAS_GOOGLE =
	!!process.env.GOOGLE_GENERATIVE_AI_API_KEY || !!process.env.GEMINI_API_KEY;

const DEFAULT_MODELS = [
	HAS_GOOGLE ? 'google/gemini-3.5-flash' : null,
	HAS_GOOGLE ? 'google/gemini-3.1-flash-lite' : null,
	HAS_OPENAI ? 'openai/gpt-4o-mini' : null,
	HAS_OPENAI ? 'openai/gpt-5-mini' : null,
	HAS_OPENAI ? 'openai/gpt-5-nano' : null,
].filter((x): x is string => !!x);

const MODELS = (
	process.env.BENCH_MODELS?.split(',').map((s) => s.trim()).filter(Boolean) ??
	DEFAULT_MODELS
);

const SCENARIOS = [
	{ id: 's1-pricing', q: 'How much does the Pro plan cost?' },
	{ id: 's2-integrations', q: 'What integrations does Acme have with GitHub?' },
	{ id: 's3-platform', q: 'Is Linux supported?' },
	{ id: 's4-residency', q: 'Where is EU data stored?' },
];

interface FloeShape {
	result: {
		text: string;
		stream: {
			ttftMs: number | null;
			endToEndMs: number | null;
			deltaCount: number;
			deltaBytes: number;
			streamingObserved: boolean;
		};
	};
}

async function startServer(model: string): Promise<ChildProcess> {
	const env = { ...process.env, PORT: String(PORT), BENCH_MODEL: model };
	const proc = spawn('tsx', ['src/server.ts'], { cwd, env });
	proc.stdout?.on('data', (b) => process.stderr.write(`[server] ${b}`));
	proc.stderr?.on('data', (b) => process.stderr.write(`[server] ${b}`));
	for (let i = 0; i < 40; i++) {
		try {
			const r = await fetch(`${BASE}/`);
			if (r.status < 500) return proc;
		} catch {
			/* not ready */
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error('Server did not become reachable');
}

async function stopServer(proc: ChildProcess): Promise<void> {
	proc.kill('SIGTERM');
	for (let i = 0; i < 20; i++) {
		if (proc.exitCode !== null) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	proc.kill('SIGKILL');
}

async function send(instanceId: string, message: string): Promise<FloeShape> {
	const r = await fetch(`${BASE}/agents/web/${instanceId}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ message }),
	});
	if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
	return (await r.json()) as FloeShape;
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	if (sorted.length === 1) return sorted[0]!;
	const rank = (p / 100) * (sorted.length - 1);
	const lo = Math.floor(rank);
	const hi = Math.ceil(rank);
	if (lo === hi) return sorted[lo]!;
	return Math.round(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo));
}

interface Stats { n: number; mean: number; p50: number; p95: number; min: number; max: number }
function summarize(values: number[]): Stats {
	const s = [...values].sort((a, b) => a - b);
	const sum = s.reduce((a, b) => a + b, 0);
	return {
		n: s.length,
		mean: s.length ? Math.round(sum / s.length) : 0,
		p50: percentile(s, 50),
		p95: percentile(s, 95),
		min: s[0] ?? 0,
		max: s[s.length - 1] ?? 0,
	};
}

interface ScenarioResult { scenarioId: string; ttftSamples: number[]; endSamples: number[]; errors: number }
interface ModelResult { model: string; scenarios: ScenarioResult[]; overall: { ttft: Stats; end: Stats; errors: number } }

async function benchModel(model: string): Promise<ModelResult> {
	console.error(`\n────── ${model} (N=${N} per scenario) ──────`);
	const server = await startServer(model);
	const scenarios: ScenarioResult[] = [];
	const allTtft: number[] = [];
	const allEnd: number[] = [];
	let totalErrors = 0;
	try {
		try { await send(`warmup-${Date.now()}`, 'warm-up'); } catch { /* ignore */ }
		for (const s of SCENARIOS) {
			const sr: ScenarioResult = { scenarioId: s.id, ttftSamples: [], endSamples: [], errors: 0 };
			for (let i = 0; i < N; i++) {
				try {
					const resp = await send(`${model.replace(/[^a-z0-9]/gi, '-')}-${s.id}-${i}`, s.q);
					const m = resp.result.stream;
					if (m.ttftMs === null || m.endToEndMs === null) {
						sr.errors += 1; totalErrors += 1; continue;
					}
					sr.ttftSamples.push(m.ttftMs);
					sr.endSamples.push(m.endToEndMs);
					allTtft.push(m.ttftMs);
					allEnd.push(m.endToEndMs);
				} catch (err) {
					sr.errors += 1; totalErrors += 1;
					console.error(`  ${s.id} iter ${i}: ERROR ${err instanceof Error ? err.message : err}`);
				}
			}
			const tt = summarize(sr.ttftSamples);
			const en = summarize(sr.endSamples);
			console.error(
				`  ${s.id.padEnd(18)} TTFT p50=${String(tt.p50).padStart(5)}ms p95=${String(tt.p95).padStart(5)}ms (min=${tt.min} max=${tt.max}) | end p50=${String(en.p50).padStart(5)}ms p95=${String(en.p95).padStart(5)}ms | errors=${sr.errors}/${N}`,
			);
			scenarios.push(sr);
		}
	} finally {
		await stopServer(server);
	}
	return { model, scenarios, overall: { ttft: summarize(allTtft), end: summarize(allEnd), errors: totalErrors } };
}

async function main(): Promise<void> {
	console.error(`[aria-bench] N=${N} per scenario, ${MODELS.length} models, ${SCENARIOS.length} scenarios. Total calls: ${MODELS.length * SCENARIOS.length * N} (+${MODELS.length} warmups)`);
	const results: ModelResult[] = [];
	for (const model of MODELS) {
		results.push(await benchModel(model));
	}

	console.log(`\n═══ AriaFlow competitor: TTFT across ${SCENARIOS.length}×${N} samples per model ═══`);
	console.log('  model                                | n  | p50  | p95  | mean | min  | max   | errors');
	console.log('  -------------------------------------|----|------|------|------|------|-------|-------');
	for (const r of results) {
		const t = r.overall.ttft;
		console.log(
			`  ${r.model.padEnd(36)} | ${String(t.n).padStart(2)} | ${String(t.p50).padStart(4)} | ${String(t.p95).padStart(4)} | ${String(t.mean).padStart(4)} | ${String(t.min).padStart(4)} | ${String(t.max).padStart(5)} | ${String(r.overall.errors).padStart(6)}`,
		);
	}

	const out = resolve(cwd, 'test', '__bench_run.json');
	await mkdir(dirname(out), { recursive: true });
	await writeFile(out, JSON.stringify({ ranAt: new Date().toISOString(), n: N, results }, null, 2));
	console.log(`\nSaved raw: ${out}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
