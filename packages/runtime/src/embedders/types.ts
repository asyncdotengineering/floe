/**
 * Pluggable text embedder. Implementations must produce a deterministic
 * `dimensions`-length vector per text. Batch is the common case; single
 * is a 1-element array.
 *
 * `model` is informational — vector stores typically tag stored vectors
 * with the embedder.model so re-indexing on a model change is detectable.
 */
export interface Embedder {
	readonly model: string;
	readonly dimensions: number;
	embed(texts: string[]): Promise<number[][]>;
}
