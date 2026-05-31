import { describe, expect, it } from 'vitest';
import { freshState } from '../src/state.ts';
import { InMemoryAssistantStateStore } from '../src/assistant-state-store.ts';

describe('state', () => {
	it('freshState produces a v1 record with zeroed counters', () => {
		const s = freshState({ assistantName: 'support', channelName: 'web' });
		expect(s.version).toBe(1);
		expect(s.assistantName).toBe('support');
		expect(s.channelName).toBe('web');
		expect(s.turnCount).toBe(0);
		expect(s.activeFlow).toBeNull();
		expect(s.activeProcedures).toEqual([]);
		expect(s.metrics.totalInputTokens).toBe(0);
	});
});

describe('AssistantStateStore — InMemory', () => {
	it('returns null for unknown sessionId', async () => {
		const store = new InMemoryAssistantStateStore();
		expect(await store.load('never-saved')).toBeNull();
	});

	it('save then load round-trips', async () => {
		const store = new InMemoryAssistantStateStore();
		const s = freshState({ assistantName: 'support', channelName: 'web' });
		s.turnCount = 3;
		await store.save('sess-1', s);
		const loaded = await store.load('sess-1');
		expect(loaded).not.toBeNull();
		expect(loaded?.turnCount).toBe(3);
		expect(loaded?.assistantName).toBe('support');
		expect(loaded?.version).toBe(1);
	});

	it('save overwrites prior state for the same sessionId', async () => {
		const store = new InMemoryAssistantStateStore();
		const s1 = freshState({ assistantName: 'support', channelName: 'web' });
		s1.turnCount = 1;
		await store.save('sess-1', s1);
		const s2 = freshState({ assistantName: 'support', channelName: 'web' });
		s2.turnCount = 7;
		await store.save('sess-1', s2);
		const loaded = await store.load('sess-1');
		expect(loaded?.turnCount).toBe(7);
	});

	it('isolates state across sessionIds', async () => {
		const store = new InMemoryAssistantStateStore();
		const a = freshState({ assistantName: 'support', channelName: 'web' });
		a.turnCount = 1;
		await store.save('alice', a);
		const b = freshState({ assistantName: 'support', channelName: 'web' });
		b.turnCount = 9;
		await store.save('bob', b);
		expect((await store.load('alice'))?.turnCount).toBe(1);
		expect((await store.load('bob'))?.turnCount).toBe(9);
	});
});
