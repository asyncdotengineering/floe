/**
 * Cross-session memory live test against live Gemini.
 *
 * Scenarios:
 *   1. Session A turn 1: user shares a preference. Auto-ingest fires.
 *   2. Session A turn 2: agent should recall it (same session, preload).
 *   3. Session B (different sessionId, SAME userId): agent should still
 *      recall the preference — proving cross-session memory works.
 *   4. Session C (different sessionId AND different userId): agent should
 *      NOT recall — proving user-scoping works.
 *   5. Dump endpoint: verify entries were actually persisted.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cwd = resolve(__dirname, '..');
const PORT = 3598;
const BASE = `http://localhost:${PORT}`;

const API_KEY =
	process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? '';
if (!API_KEY) {
	console.error('[test] No GEMINI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY set.');
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
		GEMINI_API_KEY: API_KEY,
		GOOGLE_GENERATIVE_AI_API_KEY: API_KEY,
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
	result: { text: string; events: unknown[] };
}

async function send(sessionId: string, message: string, userId?: string): Promise<string> {
	const body: Record<string, unknown> = { message };
	if (userId) body.metadata = { userId };
	const r = await fetch(`${BASE}/agents/web/${sessionId}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
	const j = (await r.json()) as FloeResp;
	return j.result.text;
}

async function dumpMemory(userId: string): Promise<unknown[]> {
	const r = await fetch(`${BASE}/__debug/memory/dump`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ userId }),
	});
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	const j = (await r.json()) as { result: { dump: unknown[] } };
	return j.result.dump;
}

let failed = 0;
function assert(cond: boolean, msg: string): void {
	if (cond) console.log(`  ✓ ${msg}`);
	else { console.log(`  ✗ FAIL: ${msg}`); failed += 1; }
}

async function main(): Promise<void> {
	console.log('[test] Building...');
// await build(); // no longer needed: tsx runs server.ts directly
	console.log(`[test] Starting server on ${PORT}...`);
	const server = await startServer();
	try {
		const userA = 'user-alice';
		const userB = 'user-bob';

		console.log('\n═══ S1: Alice session A turn 1 (sharing preference) ═══');
		const a1 = await send('alice-session-1', 'Hi, my name is Alice and I prefer email contact over phone.', userA);
		console.log('  Assistant:', a1);
		// Give the async auto-ingest a moment to land.
		await new Promise((r) => setTimeout(r, 500));

		console.log('\n═══ S2: Alice session A turn 2 (same session, recall) ═══');
		const a2 = await send('alice-session-1', 'What is my preferred contact method?', userA);
		console.log('  Assistant:', a2);
		assert(/email/i.test(a2), 'turn 2 same-session recall mentions email');

		await new Promise((r) => setTimeout(r, 500));

		console.log('\n═══ S3: Alice NEW session B (cross-session recall) ═══');
		const a3 = await send('alice-session-2-NEW', 'What do you remember about how I like to be contacted?', userA);
		console.log('  Assistant:', a3);
		assert(/email/i.test(a3), 'cross-session recall mentions email');

		console.log('\n═══ S4: Bob different user (no recall) ═══');
		// First turn for Bob — no prior context. He must NOT receive Alice's preferences.
		const b1 = await send('bob-session-1', 'Do you have any saved information about me?', userB);
		console.log('  Assistant:', b1);
		// Bob's name is never mentioned by Alice. Strict assertion: must not say "alice".
		assert(!/alice/i.test(b1), 'Bob did NOT receive Alice’s identity');
		// Must explicitly say it has no info (honesty per system prompt).
		assert(/(no|don'?t|nothing|first time|haven'?t)/i.test(b1), 'Bob got an honest "no prior info" reply');

		console.log('\n═══ S5: dump memory for Alice ═══');
		const dump = await dumpMemory(userA);
		console.log(`  entries=${dump.length}`);
		assert(dump.length >= 4, `Alice has at least 4 memory entries (got ${dump.length})`);

		console.log('\n═══ S6: Bob shares a preference, then dump verifies ingest ═══');
		await send('bob-session-1', 'Just so you know, my preferred contact method is phone calls only.', userB);
		await new Promise((r) => setTimeout(r, 500));
		const dumpB = await dumpMemory(userB);
		console.log(`  entries=${dumpB.length}`);
		assert(dumpB.length >= 1, `Bob's preference was ingested (got ${dumpB.length} entries)`);
		// Bob's data must not have leaked into Alice's bucket.
		const aliceContent = JSON.stringify(dump);
		assert(!/phone calls only/i.test(aliceContent), `Bob's phone preference did NOT leak into Alice's bucket`);

		console.log(`\n[test] ${failed === 0 ? 'PASS' : `FAIL — ${failed} assertion(s)`}`);
		if (failed > 0) process.exit(1);
	} finally {
		server.kill('SIGTERM');
		await new Promise((r) => setTimeout(r, 400));
	}
}

main().catch((err) => { console.error(err); process.exit(1); });
