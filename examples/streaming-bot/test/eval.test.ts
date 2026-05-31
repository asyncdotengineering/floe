/**
 * Answer-quality eval. For each model, fires every scenario `BENCH_N`
 * times (default 3) and captures the full response text. Then for each
 * (model, scenario, attempt) checks:
 *
 *   1. RELEVANCE — does the answer contain the expected fact?
 *   2. HALLUCINATION — does the answer contain any disallowed strings
 *      (numbers, features, locations) that are NOT in the knowledge base?
 *
 * The lists below are hand-curated from the actual knowledge/*.md files;
 * if you change knowledge, update them here too. Deliberate strict-match
 * — we want false positives that we can eyeball, not soft semantic checks.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cwd = resolve(__dirname, '..');
const PORT = 3596;
const BASE = `http://localhost:${PORT}`;
const N = Number(process.env.BENCH_N ?? '3');

const API_KEY =
	process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? '';
if (!API_KEY) {
	console.error('[eval] No GEMINI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY set.');
	process.exit(1);
}

const MODELS = (
	process.env.BENCH_MODELS?.split(',').map((s) => s.trim()).filter(Boolean) ?? [
		'google/gemini-3.5-flash',
		'google/gemini-3.1-flash-lite',
		'openai/gpt-4o-mini',
		'openai/gpt-5-mini',
		'openai/gpt-5-nano',
		'openai/gpt-5.4-mini',
	]
);

interface Scenario {
	id: string;
	q: string;
	/** Substrings the answer MUST contain (any of) to be relevant. */
	mustContainAny: string[];
	/**
	 * Patterns that, if present, indicate hallucination. These are facts that
	 * sound plausible for SaaS but are NOT in the knowledge base.
	 */
	hallucinationPatterns: RegExp[];
}

const SCENARIOS: Scenario[] = [
	{
		id: 's1-pricing',
		q: 'How much does the Pro plan cost?',
		// Knowledge says Pro is $12/user/month with 17% annual discount.
		mustContainAny: ['$12', '12 per user', '12/user', '12 a user', '12 a month'],
		hallucinationPatterns: [
			// Wrong prices for Pro (knowledge only has $12 for Pro, $19 doesn't exist anywhere).
			/\$(8|9|10|11|14|15|18|19|20|24|25|29|39|49|79|89|99)\b/,
			// Made-up team-tier prices that don't exist.
			/\$\d+\s*\/\s*team/i,
			// Knowledge does NOT mention any specific feature called "AI assistant" or "AI features".
			/\bAI\s+(assistant|features|search)\b/i,
		],
	},
	{
		id: 's2-integrations',
		q: 'What integrations does Acme have with GitHub?',
		// Knowledge: link PRs and issues to documents; comment sync.
		mustContainAny: ['pull request', 'PR', 'pr', 'issue', 'comment'],
		hallucinationPatterns: [
			// Knowledge does not mention these GitHub features.
			/\b(GitHub Actions|GitHub Copilot|CI\/CD|deploy)\b/i,
			// Made-up integration that isn't in the file.
			/\b(GitLab|Bitbucket|Azure DevOps)\b/i,
			// Specific webhook count that isn't in the docs.
			/\b\d{2,}\s+webhook(s)?\b/i,
		],
	},
	{
		id: 's3-platform',
		q: 'Is Linux supported?',
		// Knowledge: Linux is in beta.
		mustContainAny: ['beta'],
		hallucinationPatterns: [
			// Knowledge doesn't mention specific distros or GA dates.
			/\b(Ubuntu|Debian|Fedora|Arch|CentOS|RHEL)\b/i,
			// Made-up release windows.
			/\b(GA|generally available|release(d|s)?\s+(in|on)\s+\d{4})\b/i,
		],
	},
	{
		id: 's4-residency',
		q: 'Where is EU data stored?',
		// Knowledge: Frankfurt / eu-central-1.
		mustContainAny: ['Frankfurt', 'eu-central-1', 'eu-central'],
		hallucinationPatterns: [
			// Wrong EU regions.
			/\b(Dublin|London|Paris|Amsterdam|Stockholm|Madrid|Milan)\b/i,
			// Wrong AWS region codes.
			/\b(eu-west|eu-north|eu-south|us-west|ap-)/i,
			// Made-up compliance certifications (knowledge mentions none specifically by name).
			/\b(ISO\s*27001|SOC\s*2|HIPAA|GDPR-certified)\b/i,
		],
	},
];

interface StreamMetrics {
	ttftMs: number | null;
	endToEndMs: number | null;
	deltaCount: number;
	deltaBytes: number;
	streamingObserved: boolean;
}
interface FloeResponse {
	result: { text: string; events: unknown[]; stream: StreamMetrics };
}

async function build(): Promise<void> {
	await new Promise<void>((res, rej) => {
		const p = spawn('pnpm', ['build'], { cwd, stdio: 'inherit' });
		p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`build exit ${code}`))));
	});
}

async function startServer(model: string): Promise<ChildProcess> {
	const env = {
		...process.env,
		GEMINI_API_KEY: API_KEY,
		GOOGLE_GENERATIVE_AI_API_KEY: API_KEY,
		PORT: String(PORT),
		FLOE_MODEL: model,
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

async function stopServer(proc: ChildProcess): Promise<void> {
	proc.kill('SIGTERM');
	for (let i = 0; i < 20; i++) {
		if (proc.exitCode !== null) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	proc.kill('SIGKILL');
}

async function send(instanceId: string, message: string): Promise<FloeResponse> {
	const r = await fetch(`${BASE}/agents/web/${instanceId}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ message }),
	});
	if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
	return (await r.json()) as FloeResponse;
}

interface AttemptResult {
	model: string;
	scenarioId: string;
	attempt: number;
	question: string;
	answer: string;
	relevant: boolean;
	matchedExpected: string | null;
	hallucinations: string[];
	ttftMs: number | null;
}

function analyze(s: Scenario, answer: string): {
	relevant: boolean;
	matchedExpected: string | null;
	hallucinations: string[];
} {
	const lower = answer.toLowerCase();
	let matched: string | null = null;
	for (const expected of s.mustContainAny) {
		if (lower.includes(expected.toLowerCase())) {
			matched = expected;
			break;
		}
	}
	const hallucinations: string[] = [];
	for (const pat of s.hallucinationPatterns) {
		const m = answer.match(pat);
		if (m) hallucinations.push(m[0]);
	}
	return { relevant: matched !== null, matchedExpected: matched, hallucinations };
}

async function main(): Promise<void> {
	console.error(`[eval] N=${N} per (model, scenario). Total calls: ${MODELS.length * SCENARIOS.length * N}`);
	console.error('[eval] Building...');
// await build(); // no longer needed: tsx runs server.ts directly
	const all: AttemptResult[] = [];
	for (const model of MODELS) {
		console.error(`\n────── ${model} ──────`);
		const server = await startServer(model);
		try {
			// Warm-up.
			try {
				await send(`warmup-${Date.now()}`, 'warm-up');
			} catch {
				/* ignore */
			}
			for (const s of SCENARIOS) {
				for (let i = 0; i < N; i++) {
					try {
						const resp = await send(
							`${model.replace(/[^a-z0-9]/gi, '-')}-${s.id}-${i}`,
							s.q,
						);
						const text = resp.result.text;
						const a = analyze(s, text);
						all.push({
							model,
							scenarioId: s.id,
							attempt: i,
							question: s.q,
							answer: text,
							relevant: a.relevant,
							matchedExpected: a.matchedExpected,
							hallucinations: a.hallucinations,
							ttftMs: resp.result.stream.ttftMs,
						});
					} catch (err) {
						console.error(`  ${s.id} iter ${i}: ERROR ${err instanceof Error ? err.message : err}`);
					}
				}
			}
		} finally {
			await stopServer(server);
		}
	}

	// ─── Detailed dump ────────────────────────────────────────────────────
	console.log('\n═══ Answers (every attempt) ═══');
	for (const s of SCENARIOS) {
		console.log(`\n──── ${s.id}: "${s.q}" ────`);
		console.log(
			`Expected contains: ${s.mustContainAny.map((x) => `"${x}"`).join(' OR ')}`,
		);
		for (const model of MODELS) {
			const attempts = all.filter((x) => x.model === model && x.scenarioId === s.id);
			console.log(`\n  [${model}]`);
			for (const a of attempts) {
				const markers = [
					a.relevant ? `✓ matched "${a.matchedExpected}"` : '✗ MISSING expected fact',
					a.hallucinations.length > 0
						? `⚠ HALLUCINATION: ${a.hallucinations.map((h) => `"${h}"`).join(', ')}`
						: '✓ no flagged hallucinations',
				];
				console.log(`    attempt ${a.attempt}: ${markers.join('  |  ')}`);
				console.log(`      → "${a.answer.replace(/\s+/g, ' ').trim().slice(0, 300)}${a.answer.length > 300 ? '…' : ''}"`);
			}
		}
	}

	// ─── Score table ──────────────────────────────────────────────────────
	console.log('\n═══ Quality scoreboard ═══');
	console.log('  model                                | relevance% | hallucination% | n');
	console.log('  -------------------------------------|-----------|----------------|----');
	const aggregates: Array<{ model: string; rel: number; halluc: number; n: number }> = [];
	for (const model of MODELS) {
		const rows = all.filter((x) => x.model === model);
		const rel = rows.filter((x) => x.relevant).length;
		const halluc = rows.filter((x) => x.hallucinations.length > 0).length;
		aggregates.push({ model, rel, halluc, n: rows.length });
		const relPct = rows.length ? Math.round((rel * 100) / rows.length) : 0;
		const halPct = rows.length ? Math.round((halluc * 100) / rows.length) : 0;
		console.log(
			`  ${model.padEnd(36)} | ${String(relPct + '%').padStart(9)} | ${String(halPct + '%').padStart(14)} | ${String(rows.length).padStart(2)}`,
		);
	}

	console.log('\n═══ Per-scenario relevance / hallucination (count) ═══');
	const header =
		'  model                                | ' +
		SCENARIOS.map((s) => s.id.padEnd(16)).join(' | ');
	console.log(header);
	console.log('  ' + '-'.repeat(Math.max(header.length - 2, 80)));
	for (const model of MODELS) {
		const cells = SCENARIOS.map((s) => {
			const rows = all.filter((x) => x.model === model && x.scenarioId === s.id);
			const rel = rows.filter((x) => x.relevant).length;
			const halluc = rows.filter((x) => x.hallucinations.length > 0).length;
			return `R:${rel}/${rows.length} H:${halluc}/${rows.length}`.padEnd(16);
		}).join(' | ');
		console.log(`  ${model.padEnd(36)} | ${cells}`);
	}

	const out = resolve(cwd, 'test', '__eval_run.json');
	await mkdir(dirname(out), { recursive: true });
	await writeFile(out, JSON.stringify({ ranAt: new Date().toISOString(), n: N, results: all }, null, 2));
	console.log(`\nSaved raw: ${out}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
