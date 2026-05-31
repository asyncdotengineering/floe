/**
 * Universal MemoryService backed by any (Embedder + VectorStore) pair.
 *
 * One generic adapter replaces the per-backend memory services we'd
 * otherwise ship: every VectorStore implementation (in-memory / sqlite
 * / D1 / Vectorize / Pgvector) becomes a memory backend for free.
 *
 * Layout:
 *   - Each ingest creates one VectorItem per non-empty message
 *   - userId, sessionId, author, createdAt, plus any caller metadata
 *     go into the VectorItem.metadata field
 *   - Search filters by userId at the VectorStore level — provided the
 *     backend supports equality filtering, which all of ours do
 *
 * Why namespace? When multiple Floe apps share a vector store, prefix
 * stored IDs with `<namespace>:` so ingests don't collide. Default
 * 'floe-memory'.
 */
import crypto from 'node:crypto';
import type { Embedder } from '../embedders/types.ts';
import type { VectorStore } from '../vectorstores/types.ts';
import {
	DEFAULT_MEMORY_NAMESPACE,
	type IngestSessionInput,
	type IngestTurnInput,
	type MemoryEntry,
	type MemoryService,
	type SearchMemoryRequest,
} from './types.ts';

export interface VectorStoreMemoryServiceOptions {
	embedder: Embedder;
	vectorStore: VectorStore;
	/** ID prefix to keep apps from colliding in a shared store. Default 'floe-memory'. */
	namespace?: string;
}

export class VectorStoreMemoryService implements MemoryService {
	private readonly embedder: Embedder;
	private readonly store: VectorStore;
	private readonly namespace: string;

	constructor(opts: VectorStoreMemoryServiceOptions) {
		if (!opts.embedder) throw new Error('[VectorStoreMemoryService] embedder is required');
		if (!opts.vectorStore) throw new Error('[VectorStoreMemoryService] vectorStore is required');
		if (opts.embedder.dimensions !== opts.vectorStore.dimensions) {
			throw new Error(
				`[VectorStoreMemoryService] embedder.dimensions (${opts.embedder.dimensions}) ≠ vectorStore.dimensions (${opts.vectorStore.dimensions})`,
			);
		}
		this.embedder = opts.embedder;
		this.store = opts.vectorStore;
		this.namespace = opts.namespace ?? 'floe-memory';
	}

	async ingestTurn(input: IngestTurnInput): Promise<void> {
		const items: Array<{ author: 'user' | 'assistant'; content: string }> = [];
		if (input.userMessage?.trim()) items.push({ author: 'user', content: input.userMessage.trim() });
		if (input.assistantText?.trim())
			items.push({ author: 'assistant', content: input.assistantText.trim() });
		if (items.length === 0) return;

		const namespace = input.namespace ?? DEFAULT_MEMORY_NAMESPACE;
		const embeddings = await this.embedder.embed(items.map((i) => i.content));
		const now = new Date().toISOString();
		await this.store.upsert(
			items.map((it, i) => ({
				id: `${this.namespace}:${input.userId}:${namespace}:${crypto.randomUUID()}`,
				embedding: embeddings[i]!,
				text: it.content,
				metadata: {
					userId: input.userId,
					sessionId: input.sessionId,
					author: it.author,
					createdAt: now,
					namespace,
					...(input.metadata ?? {}),
				},
			})),
		);
	}

	async ingestSession(input: IngestSessionInput): Promise<void> {
		// Idempotency story for VectorStore-backed services: we can't
		// efficiently delete-by-sessionId without knowing the stored ids,
		// and a `list({filter})` op isn't part of the VectorStore interface
		// (intentionally — Vectorize and Pgvector handle this differently).
		// Practical approach: callers manage idempotency at the layer
		// above. We just upsert.
		const nonEmpty = input.messages.filter((m) => m.content.trim().length > 0);
		if (nonEmpty.length === 0) return;
		const namespace = input.namespace ?? DEFAULT_MEMORY_NAMESPACE;
		const embeddings = await this.embedder.embed(nonEmpty.map((m) => m.content));
		await this.store.upsert(
			nonEmpty.map((m, i) => ({
				id: `${this.namespace}:${input.userId}:${namespace}:${crypto.randomUUID()}`,
				embedding: embeddings[i]!,
				text: m.content.trim(),
				metadata: {
					userId: input.userId,
					sessionId: input.sessionId,
					author: m.role,
					createdAt: m.timestamp ?? new Date().toISOString(),
					namespace,
					...(input.metadata ?? {}),
				},
			})),
		);
	}

	async search(req: SearchMemoryRequest): Promise<MemoryEntry[]> {
		if (!req.query.trim()) return [];
		const [embedding] = await this.embedder.embed([req.query]);
		if (!embedding) return [];
		const filter: Record<string, unknown> = {
			userId: req.userId,
			...(req.filter ?? {}),
		};
		if (req.namespace !== undefined) filter.namespace = req.namespace;
		const matches = await this.store.query({
			embedding,
			limit: req.limit ?? 10,
			filter,
		});
		return matches.map((m) => ({
			id: m.id,
			sessionId: (m.metadata?.sessionId as string | undefined) ?? '',
			userId: req.userId,
			content: m.text,
			author: m.metadata?.author as MemoryEntry['author'],
			namespace: (m.metadata?.namespace as string | undefined) ?? DEFAULT_MEMORY_NAMESPACE,
			metadata: m.metadata,
			createdAt: (m.metadata?.createdAt as string | undefined) ?? new Date().toISOString(),
			score: m.score,
		}));
	}

	async deleteForUser(_userId: string): Promise<void> {
		// VectorStore interface lacks `delete-by-filter`. Backends with
		// rich filtering (Pgvector, Vectorize) can implement this in a
		// subclass; default is no-op with a warning.
		console.warn(
			'[VectorStoreMemoryService] deleteForUser is not supported by the generic adapter; use a backend-specific override or call vectorStore.delete(ids) yourself.',
		);
	}
}

export function vectorStoreMemoryService(opts: VectorStoreMemoryServiceOptions): VectorStoreMemoryService {
	return new VectorStoreMemoryService(opts);
}
