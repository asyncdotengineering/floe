/**
 * Vercel AI SDK adapter — wrap any `EmbeddingModel` from `ai@^6` (or any
 * other version exposing the same `doEmbed`+`maxEmbeddingsPerCall`
 * shape) so it satisfies Floe's `Embedder` interface.
 *
 * Why ship this when Floe's core embedders go direct?
 *   - AI SDK has the largest provider catalogue (Cohere, Voyage, Mistral,
 *     Together, Fireworks, Bedrock, Vertex, Groq, Anthropic, etc.)
 *   - Users who already use AI SDK in their app shouldn't have to write
 *     a new embedder just to plug it into Floe
 *
 * Why this is an OPTIONAL adapter, not the default:
 *   - `ai` is a large peer dep; many Floe apps don't need it
 *   - AI SDK has had breaking changes between v5/v6 and now v6/v7
 *     (`EmbeddingModelV2` → `EmbeddingModelV3`). Direct HTTP in
 *     `OpenAIEmbedder` is unaffected by those churns
 *   - Cloudflare bundle size: importing this adapter pulls AI SDK +
 *     the provider package into the Worker bundle
 *
 * Structurally typed against the AI SDK's embedding-model shape so this
 * file doesn't take a hard dep on `ai` — users `import { embed }` from
 * their own copy of `ai` if needed.
 */
import type { Embedder } from './types.ts';

/** Minimal structural shape that all AI SDK `EmbeddingModelV*` satisfy. */
interface AiSdkEmbeddingModelLike {
	readonly modelId?: string;
	readonly specificationVersion?: string;
	readonly maxEmbeddingsPerCall?: number | undefined;
	doEmbed(args: {
		values: string[];
		abortSignal?: AbortSignal;
		headers?: Record<string, string | undefined>;
		providerOptions?: Record<string, unknown>;
	}): Promise<{
		embeddings: number[][];
		usage?: { tokens: number };
		response?: { headers?: Record<string, string>; body?: unknown };
	}>;
}

export interface AiSdkEmbedderOptions {
	/** Any AI SDK embedding model — e.g. `openai.embedding('text-embedding-3-small')`. */
	model: AiSdkEmbeddingModelLike;
	/** Output dimension. Required because we can't introspect it from the AI SDK model. */
	dimensions: number;
	/** Name override for telemetry; defaults to `model.modelId`. */
	name?: string;
	/** Batch size cap; defaults to `model.maxEmbeddingsPerCall ?? 96`. */
	maxBatchSize?: number;
}

export class AiSdkEmbedder implements Embedder {
	readonly model: string;
	readonly dimensions: number;
	private readonly inner: AiSdkEmbeddingModelLike;
	private readonly maxBatchSize: number;

	constructor(opts: AiSdkEmbedderOptions) {
		if (!opts.model) throw new Error('[AiSdkEmbedder] model is required');
		if (!Number.isInteger(opts.dimensions) || opts.dimensions <= 0) {
			throw new Error('[AiSdkEmbedder] dimensions must be a positive integer');
		}
		this.inner = opts.model;
		this.dimensions = opts.dimensions;
		this.model = opts.name ?? opts.model.modelId ?? 'ai-sdk-embedding-model';
		this.maxBatchSize = opts.maxBatchSize ?? opts.model.maxEmbeddingsPerCall ?? 96;
	}

	async embed(texts: string[]): Promise<number[][]> {
		if (texts.length === 0) return [];
		const out: number[][] = [];
		for (let i = 0; i < texts.length; i += this.maxBatchSize) {
			const slice = texts.slice(i, i + this.maxBatchSize);
			const res = await this.inner.doEmbed({ values: slice });
			for (const v of res.embeddings) out.push(v);
		}
		return out;
	}
}

export function aiSdkEmbedder(opts: AiSdkEmbedderOptions): AiSdkEmbedder {
	return new AiSdkEmbedder(opts);
}
