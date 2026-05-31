/**
 * Live test for the streaming-bot example.
 *
 * Demonstrates that Flue is default-streaming and measures real TTFT
 * (time-to-first-text_delta) without a triage call in the path.
 *
 * Expectations:
 *   - streamingObserved=true on every turn (text_delta events fire)
 *   - ttftMs < end-to-end on every turn
 *   - ttftMs is the time from request hitting server to first delta;
 *     end-to-end is the full server-side request lifecycle.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cwd = resolve(__dirname, '..');
const PORT = 3594;
const BASE = `http://localhost:${PORT}`;

const API_KEY =
	process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? '';
if (!API_KEY) {
	console.error('[test] No GEMINI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY set.');
	process.exit(1);
}

interface StreamMetrics {
	ttftMs: number | null;
	endToEndMs: number | null;
	deltaCount: number;
	deltaBytes: number;
	streamingObserved: boolean;
}

interface FloeResponse {
	result: {
		text: string;
		events: Array<{ subtype?: string; data?: Record<string, unknown> }>;
		stream: StreamMetrics;
	};
}

async function build(): Promise<void> {
	await new Promise<void>((resolveBuild, rejectBuild) => {
		const p = spawn('pnpm', ['build'], { cwd, stdio: 'inherit' });
		p.on('exit', (code) =>
			code === 0 ? resolveBuild() : rejectBuild(new Error(`build exit ${code}`)),
		);
	});
}

async function startServer(): Promise<ChildProcess> {
	const env = {
		...process.env,
		GEMINI_API_KEY: API_KEY,
		GOOGLE_GENERATIVE_AI_API_KEY: API_KEY,
		PORT: String(PORT),
	};
	const proc = spawn('npx', ['tsx', 'server.ts'], { cwd, env });
	proc.stdout?.on('data', (b) => process.stderr.write(`[server] ${b}`));
	proc.stderr?.on('data', (b) => process.stderr.write(`[server] ${b}`));
	for (let i = 0; i < 30; i++) {
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

async function send(
	instanceId: string,
	message: string,
): Promise<{ resp: FloeResponse; clientLatencyMs: number }> {
	const start = Date.now();
	const r = await fetch(`${BASE}/agents/web/${instanceId}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ message }),
	});
	const clientLatencyMs = Date.now() - start;
	if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
	const resp = (await r.json()) as FloeResponse;
	return { resp, clientLatencyMs };
}

const SCENARIOS = [
	{ id: 'ttft-1', q: 'How much does the Pro plan cost?' },
	{ id: 'ttft-2', q: 'What integrations does Acme have with GitHub?' },
	{ id: 'ttft-3', q: 'Is Linux supported?' },
	{ id: 'ttft-4', q: 'Where is EU data stored?' },
];

interface Row {
	id: string;
	q: string;
	ttftMs: number | null;
	serverEndMs: number | null;
	clientMs: number;
	deltas: number;
	bytes: number;
	respChars: number;
	streamed: boolean;
}

async function main(): Promise<void> {
	console.log('[test] Building...');
// await build(); // no longer needed: tsx runs server.ts directly
	console.log(`[test] Starting server on port ${PORT}...`);
	const server = await startServer();
	try {
		const rows: Row[] = [];
		for (const s of SCENARIOS) {
			const { resp, clientLatencyMs } = await send(s.id, s.q);
			rows.push({
				id: s.id,
				q: s.q,
				ttftMs: resp.result.stream.ttftMs,
				serverEndMs: resp.result.stream.endToEndMs,
				clientMs: clientLatencyMs,
				deltas: resp.result.stream.deltaCount,
				bytes: resp.result.stream.deltaBytes,
				respChars: resp.result.text.length,
				streamed: resp.result.stream.streamingObserved,
			});
			console.log(
				`\n┌─ ${s.id} ─────────────────────────\n` +
					`│ Q:        ${s.q}\n` +
					`│ A:        ${resp.result.text.slice(0, 160)}${resp.result.text.length > 160 ? '…' : ''}\n` +
					`│ TTFT:     ${rows.at(-1)?.ttftMs}ms\n` +
					`│ Server:   ${rows.at(-1)?.serverEndMs}ms (end-to-end on server)\n` +
					`│ Client:   ${clientLatencyMs}ms (round trip incl. JSON serialization)\n` +
					`│ Deltas:   ${rows.at(-1)?.deltas} totalling ${rows.at(-1)?.bytes} bytes (response was ${resp.result.text.length} chars)\n` +
					`│ Streamed: ${rows.at(-1)?.streamed}\n` +
					`└──────────────────────────────`,
			);
		}

		// Assertions.
		let failed = 0;
		const assert = (cond: boolean, msg: string): void => {
			if (cond) {
				console.log(`  ✓ ${msg}`);
			} else {
				console.log(`  ✗ FAIL: ${msg}`);
				failed += 1;
			}
		};

		console.log('\n═══ Assertions ═══');
		for (const r of rows) {
			assert(r.streamed, `${r.id}: streaming observed (deltas > 0)`);
			assert(
				r.ttftMs !== null && r.ttftMs > 0,
				`${r.id}: TTFT recorded`,
			);
			assert(
				r.ttftMs !== null && r.serverEndMs !== null && r.ttftMs <= r.serverEndMs,
				`${r.id}: TTFT (${r.ttftMs}ms) <= server end-to-end (${r.serverEndMs}ms)`,
			);
			assert(
				r.deltas >= 1,
				`${r.id}: at least one text_delta event observed`,
			);
		}

		// Summary table.
		const ttfts = rows.map((r) => r.ttftMs ?? 0);
		const ends = rows.map((r) => r.serverEndMs ?? 0);
		const avg = (xs: number[]): number =>
			xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;

		console.log('\n═══ Summary ═══');
		console.log(
			'  scenario | TTFT (ms) | server end (ms) | deltas | bytes | resp chars',
		);
		for (const r of rows) {
			console.log(
				`  ${r.id.padEnd(8)} | ${String(r.ttftMs).padStart(9)} | ${String(r.serverEndMs).padStart(15)} | ${String(r.deltas).padStart(6)} | ${String(r.bytes).padStart(5)} | ${String(r.respChars).padStart(10)}`,
			);
		}
		console.log(`\n  Avg TTFT:        ${avg(ttfts)}ms`);
		console.log(`  Avg server end:  ${avg(ends)}ms`);
		console.log(`  Failed asserts:  ${failed}`);

		// Persist the results so we can quote real numbers in docs/answers.
		const out = resolve(cwd, 'test', '__last_run.json');
		await mkdir(dirname(out), { recursive: true });
		await writeFile(
			out,
			JSON.stringify(
				{ ranAt: new Date().toISOString(), rows, avgTtftMs: avg(ttfts), avgServerEndMs: avg(ends) },
				null,
				2,
			),
		);

		if (failed > 0) {
			console.log(`\n[test] FAILED (${failed} assertion(s))`);
			process.exit(1);
		}
		console.log('\n[test] PASS — streaming default confirmed, TTFT measured.');
	} finally {
		server.kill('SIGTERM');
		await new Promise((r) => setTimeout(r, 500));
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
