import { describe, expect, it } from 'vitest';
import { FakeEmbedder, fakeEmbedder } from '../src/embedders/fake.ts';
import { OpenAIEmbedder } from '../src/embedders/openai.ts';
import { WorkersAIEmbedder } from '../src/embedders/workers-ai.ts';
import { AiSdkEmbedder } from '../src/embedders/ai-sdk.ts';

describe('embedders: FakeEmbedder', () => {
	it('produces deterministic vectors of the requested dimension', async () => {
		const e = new FakeEmbedder({ dimensions: 32 });
		const [a] = await e.embed(['hello world']);
		const [b] = await e.embed(['hello world']);
		expect(a).toHaveLength(32);
		expect(a).toEqual(b);
	});

	it('different inputs → different vectors', async () => {
		const e = fakeEmbedder({ dimensions: 16 });
		const [a, b] = await e.embed(['cats', 'reciprocating-saw']);
		expect(a).not.toEqual(b);
	});

	it('batched call returns one vector per input, in order', async () => {
		const e = new FakeEmbedder();
		const texts = ['one', 'two', 'three', 'four'];
		const out = await e.embed(texts);
		expect(out).toHaveLength(4);
		expect(out.every((v) => v.length === e.dimensions)).toBe(true);
	});

	it('empty input returns empty', async () => {
		const e = new FakeEmbedder();
		expect(await e.embed([])).toEqual([]);
	});
});

describe('embedders: OpenAIEmbedder (mock fetch)', () => {
	it('posts to /embeddings with the right shape and returns ordered vectors', async () => {
		let captured: { url: string; init: RequestInit } | null = null;
		const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
			captured = { url: String(url), init: init ?? {} };
			return new Response(
				JSON.stringify({
					data: [
						{ embedding: [1, 2, 3], index: 0 },
						{ embedding: [4, 5, 6], index: 1 },
					],
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			);
		}) as typeof fetch;
		const e = new OpenAIEmbedder({
			apiKey: 'sk-test',
			model: 'text-embedding-3-small',
			dimensions: 3,
			fetch: mockFetch,
		});
		const out = await e.embed(['a', 'b']);
		expect(out).toEqual([[1, 2, 3], [4, 5, 6]]);
		expect(captured?.url).toBe('https://api.openai.com/v1/embeddings');
		expect((captured!.init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
		const body = JSON.parse(captured!.init.body as string) as Record<string, unknown>;
		expect(body.model).toBe('text-embedding-3-small');
		expect(body.dimensions).toBe(3);
		expect(body.input).toEqual(['a', 'b']);
	});

	it('respects baseUrl override (Azure / OpenRouter / Ollama)', async () => {
		let calledUrl = '';
		const mockFetch = (async (url: string | URL | Request) => {
			calledUrl = String(url);
			return new Response(JSON.stringify({ data: [{ embedding: [0], index: 0 }] }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		}) as typeof fetch;
		const e = new OpenAIEmbedder({
			apiKey: 'k',
			baseUrl: 'http://localhost:11434/v1',
			dimensions: 1,
			fetch: mockFetch,
		});
		await e.embed(['x']);
		expect(calledUrl).toBe('http://localhost:11434/v1/embeddings');
	});

	it('throws on non-2xx', async () => {
		const mockFetch = (async () =>
			new Response('forbidden', { status: 401 })) as typeof fetch;
		const e = new OpenAIEmbedder({ apiKey: 'bad', fetch: mockFetch });
		await expect(e.embed(['x'])).rejects.toThrow(/401/);
	});
});

describe('embedders: WorkersAIEmbedder (mock binding)', () => {
	it('passes texts to the binding and returns the data array', async () => {
		let receivedModel = '';
		let receivedInput: unknown = null;
		const binding = {
			async run(model: string, input: { text: string | string[] }) {
				receivedModel = model;
				receivedInput = input;
				const texts = Array.isArray(input.text) ? input.text : [input.text];
				return { data: texts.map((_, i) => [i, i + 1]) };
			},
		};
		const e = new WorkersAIEmbedder({
			binding,
			dimensions: 2,
			model: '@cf/baai/bge-small-en-v1.5',
		});
		const out = await e.embed(['a', 'b', 'c']);
		expect(receivedModel).toBe('@cf/baai/bge-small-en-v1.5');
		expect(receivedInput).toEqual({ text: ['a', 'b', 'c'] });
		expect(out).toEqual([[0, 1], [1, 2], [2, 3]]);
	});
});

describe('embedders: AiSdkEmbedder (structural adapter)', () => {
	it('wraps any AI-SDK-shaped embedding model and forwards batched calls', async () => {
		let calls = 0;
		let lastValues: string[] = [];
		const model = {
			modelId: 'text-embedding-3-small',
			specificationVersion: 'v2',
			maxEmbeddingsPerCall: 2,
			async doEmbed(args: { values: string[] }) {
				calls++;
				lastValues = args.values;
				return { embeddings: args.values.map((_v, i) => [i, i + 1, i + 2]) };
			},
		};
		const e = new AiSdkEmbedder({ model, dimensions: 3 });
		const out = await e.embed(['a', 'b', 'c']);
		// maxEmbeddingsPerCall=2 → 2 batches (a,b) + (c).
		expect(calls).toBe(2);
		expect(lastValues).toEqual(['c']);
		expect(out).toHaveLength(3);
		expect(e.model).toBe('text-embedding-3-small');
		expect(e.dimensions).toBe(3);
	});

	it('uses model.modelId as the model name by default', () => {
		const model = {
			modelId: 'my-model-id',
			async doEmbed() { return { embeddings: [] }; },
		};
		const e = new AiSdkEmbedder({ model, dimensions: 8 });
		expect(e.model).toBe('my-model-id');
	});

	it('honors `name` override', () => {
		const model = { async doEmbed() { return { embeddings: [] }; } };
		const e = new AiSdkEmbedder({ model, dimensions: 8, name: 'override' });
		expect(e.model).toBe('override');
	});

	it('throws on bad dimensions', () => {
		const model = { async doEmbed() { return { embeddings: [] }; } };
		expect(() => new AiSdkEmbedder({ model, dimensions: 0 })).toThrow(/dimensions/);
	});

	it('empty input is a no-op (no LLM call)', async () => {
		let calls = 0;
		const model = {
			async doEmbed() { calls++; return { embeddings: [] }; },
		};
		const e = new AiSdkEmbedder({ model, dimensions: 4 });
		expect(await e.embed([])).toEqual([]);
		expect(calls).toBe(0);
	});
});
