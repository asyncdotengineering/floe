/**
 * OpenAI embeddings via HTTP. Works on Node, Cloudflare Workers, Deno,
 * Bun — anywhere `fetch` is available.
 *
 * Compatible with any OpenAI-API-shaped endpoint: pass `baseUrl` for
 * Azure OpenAI, OpenRouter embedding gateways, or Ollama's
 * `/v1/embeddings`.
 */
import type { Embedder } from './types.ts';

export interface OpenAIEmbedderOptions {
	/** Required unless using a passthrough endpoint that ignores auth. */
	apiKey: string;
	/** Default: `text-embedding-3-small`. */
	model?: string;
	/** Override the API base, e.g. for Azure / OpenRouter / Ollama. */
	baseUrl?: string;
	/** Override the dimensions (smaller stored vector for text-embedding-3). */
	dimensions?: number;
	/**
	 * Max texts per HTTP request. OpenAI accepts up to 2048; we default to
	 * 96 to stay well within typical CF/Node memory + rate-limit budgets.
	 */
	maxBatchSize?: number;
	/** Optional fetch override for proxies, retry libs, etc. */
	fetch?: typeof fetch;
}

const MODEL_DIMS: Record<string, number> = {
	'text-embedding-3-small': 1536,
	'text-embedding-3-large': 3072,
	'text-embedding-ada-002': 1536,
};

export class OpenAIEmbedder implements Embedder {
	readonly model: string;
	readonly dimensions: number;
	private readonly apiKey: string;
	private readonly baseUrl: string;
	private readonly maxBatchSize: number;
	private readonly fetchFn: typeof fetch;
	private readonly requestedDimensions: number | undefined;

	constructor(opts: OpenAIEmbedderOptions) {
		if (!opts.apiKey) throw new Error('[OpenAIEmbedder] apiKey is required');
		this.apiKey = opts.apiKey;
		this.model = opts.model ?? 'text-embedding-3-small';
		this.dimensions = opts.dimensions ?? MODEL_DIMS[this.model] ?? 1536;
		this.requestedDimensions = opts.dimensions;
		this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
		this.maxBatchSize = opts.maxBatchSize ?? 96;
		this.fetchFn = opts.fetch ?? fetch;
	}

	async embed(texts: string[]): Promise<number[][]> {
		if (texts.length === 0) return [];
		const out: number[][] = [];
		for (let i = 0; i < texts.length; i += this.maxBatchSize) {
			const slice = texts.slice(i, i + this.maxBatchSize);
			const body: Record<string, unknown> = { input: slice, model: this.model };
			if (this.requestedDimensions !== undefined) body.dimensions = this.requestedDimensions;
			const res = await this.fetchFn(`${this.baseUrl}/embeddings`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${this.apiKey}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const detail = await res.text().catch(() => res.statusText);
				throw new Error(
					`[OpenAIEmbedder] ${res.status} ${res.statusText}: ${detail.slice(0, 500)}`,
				);
			}
			const json = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
			const ordered = [...json.data].sort((a, b) => a.index - b.index);
			for (const item of ordered) out.push(item.embedding);
		}
		return out;
	}
}

export function openaiEmbedder(opts: OpenAIEmbedderOptions): OpenAIEmbedder {
	return new OpenAIEmbedder(opts);
}
