/**
 * Deterministic fake embedder for tests. Generates a stable
 * `dimensions`-length vector from the SHA-256 of the text. Same text →
 * same vector; cosine similarity reflects substring overlap roughly.
 *
 * Not useful for real retrieval quality; only useful for testing wiring,
 * filters, batching, and ranking determinism.
 */
import type { Embedder } from './types.ts';
import crypto from 'node:crypto';

export interface FakeEmbedderOptions {
	dimensions?: number;
	model?: string;
}

export class FakeEmbedder implements Embedder {
	readonly model: string;
	readonly dimensions: number;
	constructor(opts: FakeEmbedderOptions = {}) {
		this.dimensions = opts.dimensions ?? 16;
		this.model = opts.model ?? 'fake-deterministic';
	}

	async embed(texts: string[]): Promise<number[][]> {
		return texts.map((t) => toVector(t, this.dimensions));
	}
}

function toVector(text: string, dim: number): number[] {
	const out = new Array<number>(dim).fill(0);
	const tokens = text
		.toLowerCase()
		.replace(/[^\w\s]/g, ' ')
		.split(/\s+/)
		.filter(Boolean);
	for (const tok of tokens) {
		const hash = crypto.createHash('sha256').update(tok).digest();
		const idx = hash.readUInt32BE(0) % dim;
		// Sign jitter so unrelated tokens partially cancel out (more
		// faithful to bag-of-words "vector" intuition).
		const sign = hash[4]! & 1 ? 1 : -1;
		out[idx] = out[idx]! + sign * (1 + (hash[5]! % 4));
	}
	// L2-normalize so cosine similarity is well-defined.
	let norm = 0;
	for (const v of out) norm += v * v;
	norm = Math.sqrt(norm) || 1;
	return out.map((v) => v / norm);
}

export function fakeEmbedder(opts: FakeEmbedderOptions = {}): FakeEmbedder {
	return new FakeEmbedder(opts);
}
