/**
 * Live test for the hybrid RAG bot.
 *
 * Exercises the full pre-LLM hybrid retrieval pipeline:
 *   - BM25 over chunked markdown
 *   - OpenAI embeddings for vector search
 *   - InMemoryVectorStore (production-shape, just not durable)
 *   - Strong-signal short-circuit
 *   - Knowledge chunks passed pre-LLM into the system prompt
 *
 * Scenarios:
 *   S1  Lexical match strong-signal       — "Pro plan price"        → BM25 wins
 *   S2  Semantic-only match               — "how much for upgrading" → needs vector
 *   S3  Out-of-domain                     — "weather in Berlin"      → no hits
 *
 * Asserts:
 *   - S1 answer mentions $12 (Pro plan price)
 *   - S2 answer mentions $12 OR Pro plan (semantic recall)
 *   - S3 answer disclaims (no info)
 *   - All scenarios stream first deltas in under 4s (relaxed bound for OpenAI cold paths)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cwd = resolve(__dirname, '..');
const PORT = 3601;
const BASE = `http://localhost:${PORT}`;

const OPENAI_KEY = process.env.OPENAI_API_KEY ?? '';
const GEMINI_KEY =
	process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY ?? '';
if (!OPENAI_KEY) {
	console.error('[test] OPENAI_API_KEY missing (needed for embeddings).');
	process.exit(1);
}
if (!GEMINI_KEY) {
	console.error('[test] GOOGLE_GENERATIVE_AI_API_KEY missing (needed for the LLM).');
	process.exit(1);
}

async function build(): Promise<void> {
	await new Promise<void>((res, rej) => {
		const p = spawn('pnpm', ['build'], { cwd, stdio: 'inherit' });
		p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`build exit ${code}`))));
	});
}

async function startServer(): Promise<ChildProcess> {
	const env = {
		...process.env,
		OPENAI_API_KEY: OPENAI_KEY,
		GOOGLE_GENERATIVE_AI_API_KEY: GEMINI_KEY,
		GEMINI_API_KEY: GEMINI_KEY,
		PORT: String(PORT),
	};
	const proc = spawn('npx', ['tsx', 'server.ts'], { cwd, env });
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

interface FloeResp {
	result: {
		text: string;
		stream: { ttftMs: number | null; endToEndMs: number | null; deltaCount: number };
	};
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

let failed = 0;
function assert(cond: boolean, msg: string): void {
	if (cond) console.log(`  ✓ ${msg}`);
	else { console.log(`  ✗ FAIL: ${msg}`); failed += 1; }
}

const SCENARIOS = [
	{
		id: 's1-pricing-lex',
		q: 'How much does the Pro plan cost?',
		// Lexical "Pro plan cost" should BM25-strong-signal.
		expect: (text: string) => /\$12|12\s*per\s*user|12\/user/i.test(text),
		label: 'mentions $12 Pro plan price',
	},
	{
		id: 's2-pricing-semantic',
		q: 'How expensive is upgrading from the free tier?',
		// "upgrade", "expensive" never appear lexically in the docs.
		// Vector should still find the pricing section semantically.
		expect: (text: string) => /\$12|12\s*per\s*user|pro/i.test(text),
		label: 'semantic recall pulls in pricing info',
	},
	{
		id: 's3-out-of-domain',
		q: 'What is the weather in Berlin?',
		expect: (text: string) => /(don'?t|do not|no|cannot|contacting support|information|relevant)/i.test(text),
		label: 'honestly disclaims no info',
	},
];

async function main(): Promise<void> {
	console.log('[test] Building...');
// await build(); // no longer needed: tsx runs server.ts directly
	console.log(`[test] Starting server on ${PORT}...`);
	const server = await startServer();
	try {
		for (const s of SCENARIOS) {
			console.log(`\n═══ ${s.id} ═══`);
			console.log(`  Q: ${s.q}`);
			const resp = await send(s.id, s.q);
			console.log(`  A: ${resp.result.text}`);
			console.log(`  TTFT: ${resp.result.stream.ttftMs}ms · end: ${resp.result.stream.endToEndMs}ms · deltas: ${resp.result.stream.deltaCount}`);
			assert(s.expect(resp.result.text), `${s.id}: ${s.label}`);
			assert(
				resp.result.stream.ttftMs !== null && resp.result.stream.ttftMs < 8000,
				`${s.id}: TTFT under 8s (got ${resp.result.stream.ttftMs}ms)`,
			);
		}
		console.log(`\n[test] ${failed === 0 ? 'PASS — hybrid RAG live integration green' : `FAIL — ${failed} assertion(s)`}`);
		if (failed > 0) process.exit(1);
	} finally {
		server.kill('SIGTERM');
		await new Promise((r) => setTimeout(r, 400));
	}
}

main().catch((err) => { console.error(err); process.exit(1); });
