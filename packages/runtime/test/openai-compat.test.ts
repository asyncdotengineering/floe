import { describe, expect, it } from 'vitest';
import { openaiCompat } from '../src/openai-compat/handler.ts';
import { Assistant } from '../src/assistant.ts';
import type { OpenAIModelList } from '../src/openai-compat/types.ts';
import { FakeEmbedder } from '../src/embedders/fake.ts';

function buildAssistants(): [Assistant, Assistant] {
	const support = new Assistant({
		name: 'support',
		systemPrompt: 'You are helpful.',
		mode: 'direct',
		model: 'google/gemini-3.1-flash-lite',
		sandbox: false,
	});
	const billing = new Assistant({
		name: 'billing',
		systemPrompt: 'You handle billing.',
		mode: 'direct',
		model: 'google/gemini-3.1-flash-lite',
		sandbox: false,
	});
	return [support, billing];
}

describe('openaiCompat: routing + responses', () => {
	it('GET /v1/models lists all assistants', async () => {
		const handler = openaiCompat({ assistants: buildAssistants() });
		const res = await handler(new Request('http://x/v1/models'));
		expect(res.status).toBe(200);
		const body = (await res.json()) as OpenAIModelList;
		const ids = body.data.map((m) => m.id).sort();
		expect(ids).toContain('floe/support');
		expect(ids).toContain('floe/billing');
		expect(body.object).toBe('list');
	});

	it('GET /v1/models also responds at /models (alias)', async () => {
		const handler = openaiCompat({ assistants: buildAssistants() });
		const res = await handler(new Request('http://x/models'));
		expect(res.status).toBe(200);
	});

	it('rejects unknown routes 404', async () => {
		const handler = openaiCompat({ assistants: buildAssistants() });
		const res = await handler(new Request('http://x/v1/unknown'));
		expect(res.status).toBe(404);
	});

	it('throws when constructed with empty assistants array', () => {
		expect(() => openaiCompat({ assistants: [] })).toThrow(/non-empty/);
	});

	it('throws when constructed with duplicate assistant names', () => {
		const [a] = buildAssistants();
		expect(() => openaiCompat({ assistants: [a, a] })).toThrow(/duplicate/);
	});

	it('authorize gate rejects 401', async () => {
		const handler = openaiCompat({
			assistants: buildAssistants(),
			authorize: () => false,
		});
		const res = await handler(new Request('http://x/v1/models'));
		expect(res.status).toBe(401);
	});

	it('authorize gate accepts via header', async () => {
		const handler = openaiCompat({
			assistants: buildAssistants(),
			authorize: (req) => req.headers.get('authorization') === 'Bearer sk-test',
		});
		const yes = await handler(
			new Request('http://x/v1/models', { headers: { authorization: 'Bearer sk-test' } }),
		);
		expect(yes.status).toBe(200);
		const no = await handler(
			new Request('http://x/v1/models', { headers: { authorization: 'Bearer wrong' } }),
		);
		expect(no.status).toBe(401);
	});

	it('POST /v1/chat/completions: rejects empty body', async () => {
		const handler = openaiCompat({ assistants: buildAssistants() });
		const res = await handler(
			new Request('http://x/v1/chat/completions', { method: 'POST', body: 'not json' }),
		);
		expect(res.status).toBe(400);
	});

	it('POST /v1/chat/completions: requires messages', async () => {
		const handler = openaiCompat({ assistants: buildAssistants() });
		const res = await handler(
			new Request('http://x/v1/chat/completions', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ model: 'floe/support' }),
			}),
		);
		expect(res.status).toBe(400);
	});

	it('POST /v1/chat/completions: rejects client tools (security)', async () => {
		const handler = openaiCompat({ assistants: buildAssistants() });
		const res = await handler(
			new Request('http://x/v1/chat/completions', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					model: 'floe/support',
					messages: [{ role: 'user', content: 'hi' }],
					tools: [{ type: 'function', function: { name: 'rm', parameters: {} } }],
				}),
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe('unsupported_parameter');
	});

	it('POST /v1/embeddings: 404 when no embedder configured', async () => {
		const handler = openaiCompat({ assistants: buildAssistants() });
		const res = await handler(
			new Request('http://x/v1/embeddings', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ model: 'embedder', input: 'hello' }),
			}),
		);
		expect(res.status).toBe(404);
	});

	it('POST /v1/embeddings: returns OpenAI-shaped response when embedder configured', async () => {
		const handler = openaiCompat({
			assistants: buildAssistants(),
			embedder: new FakeEmbedder({ dimensions: 16, model: 'fake-model' }),
		});
		const res = await handler(
			new Request('http://x/v1/embeddings', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ model: 'fake-model', input: ['hello', 'world'] }),
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			object: 'list';
			data: Array<{ object: 'embedding'; embedding: number[]; index: number }>;
			model: string;
		};
		expect(body.object).toBe('list');
		expect(body.data).toHaveLength(2);
		expect(body.data[0]!.embedding).toHaveLength(16);
		expect(body.model).toBe('fake-model');
	});
});

describe('openaiCompat: error shape conforms to OpenAI', () => {
	it('returns an `error` envelope', async () => {
		const handler = openaiCompat({ assistants: buildAssistants() });
		const res = await handler(new Request('http://x/v1/unknown'));
		const body = (await res.json()) as { error: { message: string; type: string; code: string } };
		expect(typeof body.error.message).toBe('string');
		expect(typeof body.error.type).toBe('string');
		expect(typeof body.error.code).toBe('string');
	});
});

// Note: end-to-end chat completion (POST /v1/chat/completions success path)
// requires a real LLM call and is exercised by the ecommerce-bot bench.
// The unit tests above validate the error paths and contract surface;
// streaming/buffering logic is tested in test/streaming-mux.test.ts.
