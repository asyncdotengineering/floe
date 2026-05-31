/**
 * Elaborate ecommerce eval + bench.
 *
 * 9 scenarios cover every primitive: triage to all 3 agents, both flows,
 * multi-turn, RAG retrieval (lexical + semantic), PII redaction,
 * out-of-domain refusal, escalation triggers, cross-session memory.
 *
 * Two models swept: google/gemini-3.5-flash (thinkingLevel: 'low') and
 * openai/gpt-4.1-mini. All subprocess + SSE + report machinery lives
 * in @floe/bench-harness; this file only declares scenarios + assertions.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBench, openAiJudge } from '@floe/bench-harness';
import {
	contains,
	notContains,
	enteredFlow,
	matches,
	mentionsNode,
	semanticContains,
	semanticMatches,
	semanticNotContains,
} from '@floe/runtime/eval';

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? '';
const GEMINI_KEY =
	process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY ?? '';

if (!OPENAI_KEY) {
	console.error('[bench] OPENAI_API_KEY missing (embeddings + judge).');
	process.exit(1);
}
if (!GEMINI_KEY) {
	console.error('[bench] GOOGLE_GENERATIVE_AI_API_KEY missing (Gemini run).');
	process.exit(1);
}

const judge = openAiJudge({ model: 'gpt-4.1-mini' });

const sharedEnv: Record<string, string> = {
	OPENAI_API_KEY: OPENAI_KEY,
	GOOGLE_GENERATIVE_AI_API_KEY: GEMINI_KEY,
	GEMINI_API_KEY: GEMINI_KEY,
};

const { ok } = await runBench({
	cwd,
	models: [
		{ id: 'google/gemini-3.5-flash', thinking: 'low', label: 'gemini-3.5-flash (low)', env: sharedEnv },
		{ id: 'openai/gpt-4.1-mini', label: 'gpt-4.1-mini', env: sharedEnv },
	],
	server: { port: 3602, readyTimeoutMs: 20_000 },
	scenarios: [
		{
			id: 's1-triage-product',
			description:
				'Triage routes a sizing question to the sales agent and the answer cites the catalog.',
			sessionPrefix: 's1',
			turns: [
				{
					userMessage:
						"What size should I get for the Echo Pima T-shirt? I'm usually a medium in regular tees.",
					expect: [
						contains('echo'),
						semanticContains('size', {
							intent:
								'reply gives sizing advice for the Echo Pima T-shirt (size up / size down / true to size / size M is correct, etc.)',
							judge,
						}),
						notContains("I don't"),
					],
				},
			],
		},
		{
			id: 's2-track-order',
			description: 'Tracks an order via the track-order flow.',
			sessionPrefix: 's2',
			turns: [
				{
					userMessage: 'Where is my order ord_2401?',
					expect: [enteredFlow('track-order'), contains('ord_2401')],
				},
			],
		},
		{
			id: 's3-return-eligible',
			description:
				'Return for a 27-day-old order: 100% refund of $189. Multi-turn — confirm on turn 2.',
			sessionPrefix: 's3',
			turns: [
				{
					userMessage: 'I want to return ord_2240 — the fit was wrong.',
					expect: [
						enteredFlow('return'),
						contains('189'),
						matches(/confirm|process|go ahead|shall i|want me to/i),
						notContains('outside'),
					],
				},
				{
					userMessage: 'yes, please process it',
					expect: [matches(/refund|processed|return id|rtn_/i), notContains('cancel')],
				},
			],
		},
		{
			id: 's4-return-50pct',
			description: 'Return for a 91-day-old order: outside 90-day window → denial branch.',
			sessionPrefix: 's4',
			turns: [
				{
					userMessage: 'I want to return ord_2310, the shirts shrunk.',
					expect: [enteredFlow('return'), mentionsNode('explain-denial'), notContains('100%')],
				},
			],
		},
		{
			id: 's5-pii-redaction',
			description: 'User shares email + phone — PII redaction validator masks before LLM sees.',
			sessionPrefix: 's5',
			turns: [
				{
					userMessage:
						'My email is alice@example.com and phone 415-555-1234, please update my account.',
					expect: [notContains('alice@example.com'), notContains('415-555-1234')],
				},
			],
		},
		{
			id: 's6-out-of-domain',
			description: 'Off-topic query — bot should disclaim and stay on-domain.',
			sessionPrefix: 's6',
			turns: [
				{
					userMessage: "What's the weather in Tokyo right now?",
					expect: [
						semanticNotContains('Tokyo', {
							intent:
								'reply must NOT discuss the weather/forecast/climate in Tokyo or anywhere else (out-of-domain refusal). Mentioning Tokyo only as part of declining or pivoting back to the Acme catalog is acceptable.',
							judge,
						}),
						contains('Acme'),
					],
				},
			],
		},
		{
			id: 's7-policy-shipping',
			description: 'Pulls shipping policy from knowledge base.',
			sessionPrefix: 's7',
			turns: [
				{
					userMessage: 'How much is shipping on an order under $50?',
					expect: [contains('$7'), contains('shipping')],
				},
			],
		},
		{
			id: 's8-loyalty',
			description: 'Pulls loyalty policy from knowledge base.',
			sessionPrefix: 's8',
			turns: [
				{
					userMessage: 'How do loyalty points work — what do I get?',
					expect: [
						contains('point'),
						semanticMatches(/\$5 off|100 points|1 point per dollar|tier/i, {
							intent:
								'reply explains the loyalty rewards structure — at minimum the earn rate (1 point per dollar) AND/OR redemption (100 points = $5 off) AND/OR membership tiers.',
							judge,
						}),
					],
				},
			],
		},
		{
			id: 's9-memory-cross-session',
			description:
				'Stores user preference in turn 1; recalls it in a NEW session in turn 2 (same userId).',
			sessionPrefix: 's9',
			turns: [
				{
					userMessage:
						"Hi, I'm Alice. I prefer the Forest colorway and size M in jackets — keep that in mind.",
					userId: 'alice-9',
					expect: [contains('forest')],
				},
				{
					userMessage:
						'I want to look at a new jacket — what color do you have in mind for me?',
					userId: 'alice-9',
					expect: [contains('forest')],
				},
			],
		},
	],
});

if (!ok) process.exit(1);
