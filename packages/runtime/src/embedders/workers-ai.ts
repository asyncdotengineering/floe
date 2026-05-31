/**
 * Cloudflare Workers AI embedder. Uses the `env.AI` binding (no API key
 * required) — runs entirely inside Cloudflare's edge network.
 *
 * Default model `@cf/baai/bge-base-en-v1.5` returns 768-dim vectors. The
 * `@cf/baai/bge-large-en-v1.5` model returns 1024 dims.
 *
 * This module imports zero CF-specific types at runtime so it can also
 * be type-checked in a Node toolchain; the `binding` is typed
 * structurally.
 */
import type { Embedder } from './types.ts';

interface WorkersAIBinding {
	run(
		model: string,
		input: { text: string | string[] },
	): Promise<{ shape?: number[]; data: number[][] } | { data: number[][] }>;
}

export interface WorkersAIEmbedderOptions {
	/** The CF `env.AI` binding. */
	binding: WorkersAIBinding;
	/** Default `@cf/baai/bge-base-en-v1.5` (768 dims). */
	model?: string;
	/** Override dimensions; default looked up from MODEL_DIMS. */
	dimensions?: number;
	/** Max texts per binding call. Default 96. */
	maxBatchSize?: number;
}

const MODEL_DIMS: Record<string, number> = {
	'@cf/baai/bge-small-en-v1.5': 384,
	'@cf/baai/bge-base-en-v1.5': 768,
	'@cf/baai/bge-large-en-v1.5': 1024,
};

export class WorkersAIEmbedder implements Embedder {
	readonly model: string;
	readonly dimensions: number;
	private readonly binding: WorkersAIBinding;
	private readonly maxBatchSize: number;

	constructor(opts: WorkersAIEmbedderOptions) {
		if (!opts.binding) throw new Error('[WorkersAIEmbedder] binding is required');
		this.binding = opts.binding;
		this.model = opts.model ?? '@cf/baai/bge-base-en-v1.5';
		this.dimensions = opts.dimensions ?? MODEL_DIMS[this.model] ?? 768;
		this.maxBatchSize = opts.maxBatchSize ?? 96;
	}

	async embed(texts: string[]): Promise<number[][]> {
		if (texts.length === 0) return [];
		const out: number[][] = [];
		for (let i = 0; i < texts.length; i += this.maxBatchSize) {
			const slice = texts.slice(i, i + this.maxBatchSize);
			const res = await this.binding.run(this.model, { text: slice });
			for (const vec of res.data) out.push(vec);
		}
		return out;
	}
}

export function workersAiEmbedder(opts: WorkersAIEmbedderOptions): WorkersAIEmbedder {
	return new WorkersAIEmbedder(opts);
}
