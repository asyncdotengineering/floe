import { describe, expect, it } from 'vitest';
import { InMemoryTranscriptStore, makeTranscriptMessage } from '../src/transcript-store.ts';

describe('TranscriptStore — InMemory', () => {
	it('returns empty list for unknown session', async () => {
		const store = new InMemoryTranscriptStore();
		const r = await store.list('never-seen');
		expect(r.messages).toEqual([]);
		expect(r.nextCursor).toBeNull();
	});

	it('append + list returns messages in insertion order with text + role', async () => {
		const store = new InMemoryTranscriptStore();
		const t0 = Date.now() - 1000;
		await store.append(
			'sess',
			makeTranscriptMessage({ role: 'user', text: 'hi', createdAt: t0 }),
		);
		await store.append(
			'sess',
			makeTranscriptMessage({ role: 'assistant', text: 'hello there', createdAt: t0 + 100 }),
		);
		const r = await store.list('sess');
		expect(r.messages).toHaveLength(2);
		expect(r.messages[0]!.role).toBe('user');
		expect(r.messages[0]!.parts[0]!.text).toBe('hi');
		expect(r.messages[1]!.role).toBe('assistant');
		expect(r.messages[1]!.parts[0]!.text).toBe('hello there');
		expect(r.nextCursor).toBeNull();
	});

	it('paginates via limit + cursor', async () => {
		const store = new InMemoryTranscriptStore();
		for (let i = 0; i < 5; i++) {
			await store.append('sess', makeTranscriptMessage({ role: 'user', text: `msg ${i}` }));
		}
		const page1 = await store.list('sess', { limit: 2 });
		expect(page1.messages).toHaveLength(2);
		expect(page1.nextCursor).toBe('2');
		const page2 = await store.list('sess', { limit: 2, cursor: page1.nextCursor! });
		expect(page2.messages).toHaveLength(2);
		expect(page2.nextCursor).toBe('4');
		const page3 = await store.list('sess', { limit: 2, cursor: page2.nextCursor! });
		expect(page3.messages).toHaveLength(1);
		expect(page3.nextCursor).toBeNull();
	});

	it('listSessions returns one entry per session for a user, newest first', async () => {
		const store = new InMemoryTranscriptStore();
		await store.append(
			'a',
			makeTranscriptMessage({ role: 'user', text: 'alpha', userId: 'u1', createdAt: 1000 }),
		);
		await store.append(
			'b',
			makeTranscriptMessage({ role: 'user', text: 'beta', userId: 'u1', createdAt: 2000 }),
		);
		await store.append(
			'c',
			makeTranscriptMessage({ role: 'user', text: 'cee', userId: 'u2', createdAt: 1500 }),
		);
		const r = await store.listSessions('u1');
		expect(r.sessions.map((s) => s.sessionId)).toEqual(['b', 'a']);
		expect(r.sessions[0]!.preview).toBe('beta');
		expect(r.sessions[0]!.turnCount).toBe(1);
	});

	it('delete removes a session', async () => {
		const store = new InMemoryTranscriptStore();
		await store.append('sess', makeTranscriptMessage({ role: 'user', text: 'hi' }));
		await store.delete('sess');
		const r = await store.list('sess');
		expect(r.messages).toEqual([]);
	});

	it('makeTranscriptMessage assigns an id when omitted', () => {
		const m = makeTranscriptMessage({ role: 'user', text: 'x' });
		expect(typeof m.id).toBe('string');
		expect(m.id.length).toBeGreaterThan(4);
	});
});
