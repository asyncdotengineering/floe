/**
 * AriaFlow flow bench. Mirrors @floe/example-flow-bot's bench so the two
 * outputs are directly comparable.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cwd = resolve(__dirname, '..');
const PORT = 3600;
const BASE = `http://localhost:${PORT}`;
const N = Number(process.env.BENCH_N ?? '5');
const MODEL = process.env.BENCH_MODEL ?? 'openai/gpt-4.1-mini';

if (!process.env.OPENAI_API_KEY) {
	console.error('[bench] OPENAI_API_KEY missing'); process.exit(1);
}

const SCENARIOS = [
	{ id: 'f1-friday2', q: 'Book me for Friday at 2pm — my name is Alice.' },
	{ id: 'f2-monday10', q: "Hi I'm Bob, can you schedule me for Monday at 10am?" },
	{ id: 'f3-tomorrow', q: "Name is Carol, slot is tomorrow at 3pm please." },
	{ id: 'f4-eve', q: "Dana here — book me Wednesday evening at 6pm." },
];

interface FloeResp {
	result: { text: string; stream: { ttftMs: number | null; endToEndMs: number | null; deltaCount: number; deltaBytes: number; streamingObserved: boolean } };
}

async function startServer(): Promise<ChildProcess> {
	const env = { ...process.env, PORT: String(PORT), BENCH_MODEL: MODEL };
	const proc = spawn('tsx', ['src/server.ts'], { cwd, env });
	proc.stdout?.on('data', (b) => process.stderr.write(`[server] ${b}`));
	proc.stderr?.on('data', (b) => process.stderr.write(`[server] ${b}`));
	for (let i = 0; i < 40; i++) {
		try { const r = await fetch(`${BASE}/`); if (r.status < 500) return proc; } catch { /* */ }
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error('server unreachable');
}

async function send(id: string, message: string): Promise<FloeResp> {
	const r = await fetch(`${BASE}/agents/web/${id}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ message }),
	});
	if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
	return (await r.json()) as FloeResp;
}

function pct(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	if (sorted.length === 1) return sorted[0]!;
	const r = (p / 100) * (sorted.length - 1);
	const lo = Math.floor(r), hi = Math.ceil(r);
	if (lo === hi) return sorted[lo]!;
	return Math.round(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (r - lo));
}

async function main(): Promise<void> {
	console.error(`[aria-flow-bench] model=${MODEL} N=${N} scenarios=${SCENARIOS.length} totalCalls=${SCENARIOS.length * N}+1warmup`);
	const proc = await startServer();
	const allTtft: number[] = [], allEnd: number[] = [];
	const perScenario: Array<{ id: string; ttft: number[]; end: number[]; texts: string[] }> = [];
	try {
		try { await send(`warmup-${Date.now()}`, 'warm-up please'); } catch { /* */ }
		for (const s of SCENARIOS) {
			const ttft: number[] = [], end: number[] = [], texts: string[] = [];
			for (let i = 0; i < N; i++) {
				try {
					const resp = await send(`${s.id}-${i}`, s.q);
					if (resp.result.stream.ttftMs !== null) ttft.push(resp.result.stream.ttftMs);
					if (resp.result.stream.endToEndMs !== null) end.push(resp.result.stream.endToEndMs);
					texts.push(resp.result.text);
				} catch (err) {
					console.error(`  ${s.id} iter ${i}: ERROR ${err instanceof Error ? err.message : err}`);
				}
			}
			ttft.sort((a, b) => a - b); end.sort((a, b) => a - b);
			console.error(`  ${s.id.padEnd(15)} TTFT p50=${String(pct(ttft, 50)).padStart(5)}ms p95=${String(pct(ttft, 95)).padStart(5)}ms | end p50=${String(pct(end, 50)).padStart(5)}ms p95=${String(pct(end, 95)).padStart(5)}ms`);
			console.error(`     sample reply: ${texts[0]?.slice(0, 140) ?? '(none)'}`);
			perScenario.push({ id: s.id, ttft, end, texts });
			allTtft.push(...ttft); allEnd.push(...end);
		}
	} finally {
		proc.kill('SIGTERM');
		await new Promise((r) => setTimeout(r, 400));
	}
	allTtft.sort((a, b) => a - b); allEnd.sort((a, b) => a - b);
	console.log(`\n═══ AriaFlow flow bench: ${MODEL} ═══`);
	console.log(`  TTFT n=${allTtft.length} p50=${pct(allTtft, 50)}ms p95=${pct(allTtft, 95)}ms mean=${Math.round(allTtft.reduce((a, b) => a + b, 0) / Math.max(allTtft.length, 1))}ms`);
	console.log(`  END  n=${allEnd.length} p50=${pct(allEnd, 50)}ms p95=${pct(allEnd, 95)}ms mean=${Math.round(allEnd.reduce((a, b) => a + b, 0) / Math.max(allEnd.length, 1))}ms`);

	const out = resolve(cwd, 'test', '__bench_run.json');
	await mkdir(dirname(out), { recursive: true });
	await writeFile(out, JSON.stringify({ ranAt: new Date().toISOString(), model: MODEL, perScenario, allTtft, allEnd }, null, 2));
	console.log(`\nSaved raw: ${out}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
