/**
 * Floe flow benchmark — exercises a 3-node chain inside one user turn.
 * Same scenarios as before; the harness now owns subprocess + timing
 * + reporting.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBench } from '@floe/bench-harness';
import { contains } from '@floe/runtime/eval';

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (!process.env.OPENAI_API_KEY) {
	console.error('[bench] OPENAI_API_KEY missing');
	process.exit(1);
}

const { ok } = await runBench({
	cwd,
	models: [process.env.FLOE_MODEL ?? 'openai/gpt-4.1-mini'],
	server: { port: 3599 },
	scenarios: [
		{
			id: 'f1-friday2',
			turns: [{
				userMessage: 'Book me for Friday at 2pm — my name is Alice.',
				expect: [contains('Alice')],
			}],
		},
		{
			id: 'f2-monday10',
			turns: [{
				userMessage: "Hi I'm Bob, can you schedule me for Monday at 10am?",
				expect: [contains('Bob')],
			}],
		},
		{
			id: 'f3-tomorrow',
			turns: [{
				userMessage: 'Name is Carol, slot is tomorrow at 3pm please.',
				expect: [contains('Carol')],
			}],
		},
		{
			id: 'f4-eve',
			turns: [{
				userMessage: 'Dana here — book me Wednesday evening at 6pm.',
				expect: [contains('Dana')],
			}],
		},
	],
});

if (!ok) process.exit(1);
