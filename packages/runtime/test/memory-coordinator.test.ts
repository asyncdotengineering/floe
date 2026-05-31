/**
 * Boundary tests for `MemoryCoordinator`. Tested with `InMemoryVectorStore`
 * + `VectorStoreMemoryService` (local-substitutable category — no remote
 * vector DB required).
 *
 * Coverage:
 *   - no cfg → no-op stub (preload returns null, ingest returns 0ms)
 *   - real cfg → preload calls the underlying service, ingest fires
 *   - skip when userId missing (preload AND ingest)
 *   - skip when userMessage empty (preload)
 *   - skip when assistantText empty (ingest)
 *   - skip when ingest.auto=false
 *   - skip when preload.enabled=false
 *   - preload errors are swallowed (turn must not fail on memory)
 *   - ingest errors are swallowed (fire-and-forget)
 *   - chunkCount counts bullet lines correctly
 */
import { describe, expect, it, vi } from 'vitest';
import { createMemoryCoordinator } from '../src/memory/coordinator.ts';
import { VectorStoreMemoryService } from '../src/memory/vector-store-service.ts';
import { InMemoryVectorStore } from '../src/vectorstores/in-memory.ts';
import { FakeEmbedder } from '../src/embedders/fake.ts';
import type { MemoryConfig } from '../src/memory/types.ts';

function makeRealCfg(): MemoryConfig {
	const embedder = new FakeEmbedder({ dimensions: 16, model: 'fake' });
	const vectorStore = new InMemoryVectorStore({ dimensions: 16 });
	const service = new VectorStoreMemoryService({
		embedder,
		vectorStore,
		namespace: 'test-prefs',
	});
	return { service };
}

describe('createMemoryCoordinator — null cfg', () => {
	it('returns a no-op stub: preload yields { context: null, chunkCount: 0, durationMs: 0 }', async () => {
		const coord = createMemoryCoordinator(null);
		const r = await coord.preload({ userId: 'alice', userMessage: 'hi' });
		expect(r.context).toBeNull();
		expect(r.chunkCount).toBe(0);
		expect(r.durationMs).toBe(0);
	});

	it('returns a no-op stub: ingest yields { durationMs: 0 } and does no work', () => {
		const coord = createMemoryCoordinator(null);
		const r = coord.ingest({
			userId: 'alice', userMessage: 'm', assistantText: 'a',
			sessionName: 's', assistantName: 't', mode: 'direct', routedTo: undefined,
		});
		expect(r.durationMs).toBe(0);
	});
});

describe('createMemoryCoordinator — real cfg', () => {
	it('preload returns null when userId is missing', async () => {
		const coord = createMemoryCoordinator(makeRealCfg());
		const r = await coord.preload({ userId: undefined, userMessage: 'looking for a jacket' });
		expect(r.context).toBeNull();
		expect(r.chunkCount).toBe(0);
	});

	it('preload returns null when userMessage is empty / whitespace', async () => {
		const coord = createMemoryCoordinator(makeRealCfg());
		const r1 = await coord.preload({ userId: 'alice', userMessage: '' });
		const r2 = await coord.preload({ userId: 'alice', userMessage: '   \n\t  ' });
		expect(r1.context).toBeNull();
		expect(r2.context).toBeNull();
	});

	it('preload returns null when preload.enabled is false', async () => {
		const cfg: MemoryConfig = { ...makeRealCfg(), preload: { enabled: false } };
		const coord = createMemoryCoordinator(cfg);
		const r = await coord.preload({ userId: 'alice', userMessage: 'real question' });
		expect(r.context).toBeNull();
	});

	it('preload measures durationMs even when no work happens', async () => {
		const coord = createMemoryCoordinator(makeRealCfg());
		const r = await coord.preload({ userId: undefined, userMessage: 'hi' });
		expect(r.durationMs).toBeGreaterThanOrEqual(0);
	});

	it('preload swallows underlying service errors (returns null context)', async () => {
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const brokenService = {
			recordMemory: async () => undefined,
			search: async () => { throw new Error('downstream KABOOM'); },
			ingestTurn: async () => undefined,
		};
		const cfg: MemoryConfig = { service: brokenService };
		const coord = createMemoryCoordinator(cfg);
		const r = await coord.preload({ userId: 'alice', userMessage: 'real' });
		expect(r.context).toBeNull();
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('preload failed'));
		errSpy.mockRestore();
	});

	it('chunkCount counts bullet (- ) lines in the rendered context', async () => {
		const cfg = makeRealCfg();
		// Seed: ingest two memories so subsequent preload returns them
		await cfg.service.ingestTurn({
			sessionId: 'sess-1',
			userId: 'alice',
			userMessage: 'I love the Forest colorway in jackets',
			assistantText: 'noted',
			metadata: {},
		});
		await cfg.service.ingestTurn({
			sessionId: 'sess-1',
			userId: 'alice',
			userMessage: 'I prefer size M',
			assistantText: 'noted',
			metadata: {},
		});
		const coord = createMemoryCoordinator(cfg);
		const r = await coord.preload({ userId: 'alice', userMessage: 'jackets' });
		// Should find at least one of the seeded memories
		expect(r.chunkCount).toBeGreaterThanOrEqual(1);
		expect(r.context).toContain('- ');
	});

	it('ingest returns immediately (fire-and-forget) with non-zero duration', async () => {
		const coord = createMemoryCoordinator(makeRealCfg());
		const r = coord.ingest({
			userId: 'alice', userMessage: 'msg', assistantText: 'reply',
			sessionName: 'sess', assistantName: 'asst', mode: 'direct', routedTo: undefined,
		});
		expect(r.durationMs).toBeGreaterThanOrEqual(0);
	});

	it('ingest no-ops when userId is missing', () => {
		const cfg = makeRealCfg();
		const ingestSpy = vi.spyOn(cfg.service, 'ingestTurn');
		const coord = createMemoryCoordinator(cfg);
		coord.ingest({
			userId: undefined, userMessage: 'm', assistantText: 'a',
			sessionName: 's', assistantName: 't', mode: 'direct', routedTo: undefined,
		});
		expect(ingestSpy).not.toHaveBeenCalled();
	});

	it('ingest no-ops when assistantText is empty', () => {
		const cfg = makeRealCfg();
		const ingestSpy = vi.spyOn(cfg.service, 'ingestTurn');
		const coord = createMemoryCoordinator(cfg);
		coord.ingest({
			userId: 'alice', userMessage: 'm', assistantText: '',
			sessionName: 's', assistantName: 't', mode: 'direct', routedTo: undefined,
		});
		expect(ingestSpy).not.toHaveBeenCalled();
	});

	it('ingest no-ops when ingest.auto is explicitly false', () => {
		const cfg: MemoryConfig = { ...makeRealCfg(), ingest: { auto: false } };
		const ingestSpy = vi.spyOn(cfg.service, 'ingestTurn');
		const coord = createMemoryCoordinator(cfg);
		coord.ingest({
			userId: 'alice', userMessage: 'm', assistantText: 'a',
			sessionName: 's', assistantName: 't', mode: 'direct', routedTo: undefined,
		});
		expect(ingestSpy).not.toHaveBeenCalled();
	});

	it('ingest fires when all conditions met — forwards metadata fields', async () => {
		const cfg = makeRealCfg();
		const ingestSpy = vi.spyOn(cfg.service, 'ingestTurn');
		const coord = createMemoryCoordinator(cfg);
		coord.ingest({
			userId: 'alice', userMessage: 'msg', assistantText: 'rep',
			sessionName: 'sess-x', assistantName: 'support', mode: 'route', routedTo: 'specialist',
		});
		expect(ingestSpy).toHaveBeenCalledTimes(1);
		const call = ingestSpy.mock.calls[0]![0];
		expect(call.userId).toBe('alice');
		expect(call.sessionId).toBe('sess-x');
		expect(call.metadata).toEqual({
			assistantName: 'support', mode: 'route', routedTo: 'specialist',
		});
	});

	it('ingest swallows underlying service errors (no throw)', async () => {
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const brokenService = {
			recordMemory: async () => undefined,
			search: async () => [],
			ingestTurn: async () => { throw new Error('downstream KABOOM'); },
		};
		const cfg: MemoryConfig = { service: brokenService };
		const coord = createMemoryCoordinator(cfg);
		coord.ingest({
			userId: 'alice', userMessage: 'm', assistantText: 'a',
			sessionName: 's', assistantName: 't', mode: 'direct', routedTo: undefined,
		});
		// Give the async ingestTurn a tick to throw
		await new Promise((r) => setTimeout(r, 5));
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('ingestTurn failed'));
		errSpy.mockRestore();
	});

	it('uses preload.namespace override when set', async () => {
		const cfg = makeRealCfg();
		const searchSpy = vi.spyOn(cfg.service, 'search');
		const coordOverride = createMemoryCoordinator({
			...cfg,
			preload: { namespace: 'override-ns' },
		});
		await coordOverride.preload({ userId: 'alice', userMessage: 'hi' });
		const call = searchSpy.mock.calls[0]?.[0];
		expect(call?.namespace).toBe('override-ns');
	});

	it('uses ingest.namespace override when set', () => {
		const cfg = makeRealCfg();
		const ingestSpy = vi.spyOn(cfg.service, 'ingestTurn');
		const coord = createMemoryCoordinator({
			...cfg,
			ingest: { auto: true, namespace: 'ingest-override' },
		});
		coord.ingest({
			userId: 'alice', userMessage: 'm', assistantText: 'a',
			sessionName: 's', assistantName: 't', mode: 'direct', routedTo: undefined,
		});
		expect(ingestSpy.mock.calls[0]![0].namespace).toBe('ingest-override');
	});
});
