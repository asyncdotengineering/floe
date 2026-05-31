/**
 * Streaming-bot bench — sweeps small/fast Gemini + OpenAI models on a
 * handful of FAQ-style prompts. The harness owns subprocess lifecycle,
 * SSE TTFT measurement, and the per-model report matrix.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBench } from '@floe/bench-harness';
import { contains } from '@floe/runtime/eval';

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const API_KEY =
	process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? '';
if (!API_KEY) {
	console.error('[bench] No GEMINI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY set.');
	process.exit(1);
}

const MODELS =
	process.env.BENCH_MODELS?.split(',').map((s) => s.trim()).filter(Boolean) ?? [
		'google/gemini-3.5-flash',
		'google/gemini-3.1-flash-lite',
		'openai/gpt-4o-mini',
		'openai/gpt-5-mini',
		'openai/gpt-5-nano',
		'openai/gpt-5.4-mini',
	];

const sharedEnv: Record<string, string> = {
	GEMINI_API_KEY: API_KEY,
	GOOGLE_GENERATIVE_AI_API_KEY: API_KEY,
};

const { ok } = await runBench({
	cwd,
	models: MODELS.map((id) => ({ id, env: sharedEnv })),
	server: { port: 3595 },
	scenarios: [
		{
			id: 's1-pricing',
			turns: [{
				userMessage: 'How much does the Pro plan cost?',
				expect: [contains('plan')],
			}],
		},
		{
			id: 's2-integrations',
			turns: [{
				userMessage: 'What integrations does Acme have with GitHub?',
				expect: [contains('GitHub')],
			}],
		},
		{
			id: 's3-platform',
			turns: [{
				userMessage: 'Is Linux supported?',
				expect: [contains('Linux')],
			}],
		},
		{
			id: 's4-residency',
			turns: [{
				userMessage: 'Where is EU data stored?',
				expect: [contains('EU')],
			}],
		},
	],
});

if (!ok) process.exit(1);
