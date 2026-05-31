/**
 * Boundary tests for `runBench` orchestration.
 *
 * We spawn a tiny fake server (a single-file Node HTTP listener that
 * mimics the Floe SSE wire) instead of booting a real Assistant.
 * That keeps tests fast + offline AND exercises the real subprocess
 * lifecycle, SSE parsing, assertion application, and report writing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBench } from '../src/index.ts';
import type { Assertion } from '@floe/runtime/eval';

const FAKE_SERVER_SRC = `
import { createServer } from 'node:http';
const port = Number(process.env.PORT ?? 3000);
const FLOE_MODEL = process.env.FLOE_MODEL ?? 'unknown';
const server = createServer(async (req, res) => {
	if (req.method === 'GET' && req.url === '/') {
		res.writeHead(200).end('ok');
		return;
	}
	if (req.method === 'POST' && req.url?.startsWith('/agents/web/')) {
		let body = '';
		req.on('data', (c) => (body += c));
		await new Promise((r) => req.on('end', r));
		const reply = body.includes('say-pong') ? 'pong from ' + FLOE_MODEL : 'hello from ' + FLOE_MODEL;
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		// Emit the canonical chat.completion.chunk wire for the reply text.
		const chunk = {
			choices: [{ delta: { content: reply }, finish_reason: null }],
		};
		res.write('data: ' + JSON.stringify(chunk) + '\\n\\n');
		const last = { choices: [{ delta: {}, finish_reason: 'stop' }] };
		res.write('data: ' + JSON.stringify(last) + '\\n\\n');
		res.write('data: [DONE]\\n\\n');
		res.end();
		return;
	}
	res.writeHead(404).end();
});
server.listen(port);
process.on('SIGTERM', () => { server.close(); process.exit(0); });
`;

const tmpDirs: string[] = [];

afterEach(async () => {
	for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
	tmpDirs.length = 0;
});

async function fakeServerDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'floe-bench-test-'));
	tmpDirs.push(dir);
	await writeFile(join(dir, 'server.ts'), FAKE_SERVER_SRC);
	return dir;
}

const containsAssertion = (needle: string): Assertion => ({
	name: `contains("${needle}")`,
	check: (ctx) =>
		ctx.text.toLowerCase().includes(needle.toLowerCase())
			? { pass: true }
			: { pass: false, message: `text "${ctx.text}" does not contain "${needle}"` },
});

async function freePort(): Promise<number> {
	const { createServer } = await import('node:net');
	return await new Promise<number>((resolve, reject) => {
		const s = createServer();
		s.listen(0, () => {
			const addr = s.address();
			if (addr && typeof addr === 'object') {
				const port = addr.port;
				s.close(() => resolve(port));
			} else {
				s.close();
				reject(new Error('no port'));
			}
		});
		s.on('error', reject);
	});
}

describe('runBench — end-to-end with a fake server', () => {
	it('runs one model × two scenarios and produces a passing report', async () => {
		const cwd = await fakeServerDir();
		const port = await freePort();
		const { report, ok } = await runBench({
			cwd,
			models: ['fake/test-model'],
			scenarios: [
				{
					id: 's1-greet',
					turns: [{ userMessage: 'greet me', expect: [containsAssertion('hello')] }],
				},
				{
					id: 's2-pong',
					turns: [{ userMessage: 'say-pong', expect: [containsAssertion('pong')] }],
				},
			],
			server: { port },
			warmup: false,
			reportPath: false,
			printConsoleReport: false,
		});
		expect(ok).toBe(true);
		expect(report.models).toHaveLength(1);
		expect(report.models[0]!.scenarios).toHaveLength(2);
		expect(report.models[0]!.scenarios.every((s) => s.pass)).toBe(true);
	}, 20_000);

	it('fails the run when an assertion fails (ok=false, scenario marked fail)', async () => {
		const cwd = await fakeServerDir();
		const port = await freePort();
		const { report, ok } = await runBench({
			cwd,
			models: ['fake/test-model'],
			scenarios: [
				{
					id: 's-impossible',
					turns: [
						{
							userMessage: 'greet me',
							expect: [containsAssertion('NOT-IN-RESPONSE-XYZ')],
						},
					],
				},
			],
			server: { port },
			warmup: false,
			reportPath: false,
			printConsoleReport: false,
		});
		expect(ok).toBe(false);
		expect(report.models[0]!.scenarios[0]!.pass).toBe(false);
		expect(report.models[0]!.scenarios[0]!.turns[0]!.assertions[0]!.pass).toBe(false);
	}, 20_000);

	it('sweeps multiple models — each gets its own server spawn', async () => {
		const cwd = await fakeServerDir();
		const port = await freePort();
		const { report } = await runBench({
			cwd,
			models: [
				{ id: 'fake/model-a', label: 'model-a' },
				{ id: 'fake/model-b', label: 'model-b' },
			],
			scenarios: [
				{
					id: 's-only',
					turns: [{ userMessage: 'greet me', expect: [containsAssertion('hello')] }],
				},
			],
			server: { port },
			warmup: false,
			reportPath: false,
			printConsoleReport: false,
		});
		expect(report.models).toHaveLength(2);
		expect(report.models.map((m) => m.label)).toEqual(['model-a', 'model-b']);
		// The fake server echoes FLOE_MODEL — proves per-model env propagation.
		expect(report.models[0]!.scenarios[0]!.turns[0]!.assistantText).toContain('fake/model-a');
		expect(report.models[1]!.scenarios[0]!.turns[0]!.assistantText).toContain('fake/model-b');
	}, 30_000);

	it('writes the JSON report to disk when reportPath is set', async () => {
		const cwd = await fakeServerDir();
		const port = await freePort();
		const reportPath = join(cwd, 'out.json');
		await runBench({
			cwd,
			models: ['fake/test-model'],
			scenarios: [
				{
					id: 's-only',
					turns: [{ userMessage: 'greet me', expect: [containsAssertion('hello')] }],
				},
			],
			server: { port },
			warmup: false,
			reportPath,
			printConsoleReport: false,
		});
		const raw = await readFile(reportPath, 'utf8');
		const persisted = JSON.parse(raw) as { models: unknown[] };
		expect(persisted.models).toHaveLength(1);
	}, 20_000);
});
