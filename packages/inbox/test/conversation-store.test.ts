import { describe, expect, it } from 'vitest';
import {
	InMemoryConversationStore,
	type ConversationStore,
	type OutcomesRollup,
} from '../src/conversation-store.ts';
import { makeConversation } from '../src/conversation.ts';
import { makeTurn } from '../src/turn.ts';
import type { Identity } from '../src/identity.ts';

const tenantA: Identity = { tenantId: 'tenant-a', userId: 'alice' };
const tenantB: Identity = { tenantId: 'tenant-b', userId: 'bob' };

function freshStore(): ConversationStore {
	return new InMemoryConversationStore();
}

describe('ConversationStore', () => {
	describe('upsertConversation + getConversation', () => {
		it('round-trips a conversation', async () => {
			const store = freshStore();
			const conv = makeConversation({
				tenantId: tenantA.tenantId,
				identity: tenantA,
			});
			await store.upsertConversation(conv);
			const got = await store.getConversation(tenantA.tenantId, conv.id);
			expect(got).not.toBeNull();
			expect(got!.id).toBe(conv.id);
			expect(got!.tenantId).toBe(tenantA.tenantId);
		});

		it('returns null for unknown conversation id', async () => {
			const store = freshStore();
			const got = await store.getConversation(tenantA.tenantId, 'nonexistent');
			expect(got).toBeNull();
		});

		it('upsert overwrites an existing conversation', async () => {
			const store = freshStore();
			const conv = makeConversation({
				id: 'same-id',
				tenantId: tenantA.tenantId,
				identity: tenantA,
			});
			await store.upsertConversation(conv);
			conv.status = 'closed';
			await store.upsertConversation(conv);
			const got = await store.getConversation(tenantA.tenantId, 'same-id');
			expect(got!.status).toBe('closed');
		});

		it('tenant A data is invisible to tenant B', async () => {
			const store = freshStore();
			const convA = makeConversation({
				tenantId: tenantA.tenantId,
				identity: tenantA,
			});
			await store.upsertConversation(convA);
			const got = await store.getConversation(tenantB.tenantId, convA.id);
			expect(got).toBeNull();
		});
	});

	describe('listConversations', () => {
		it('returns only conversations for the given tenant', async () => {
			const store = freshStore();
			const c1 = makeConversation({
				tenantId: tenantA.tenantId,
				identity: tenantA,
			});
			const c2 = makeConversation({
				tenantId: tenantB.tenantId,
				identity: tenantB,
			});
			await store.upsertConversation(c1);
			await store.upsertConversation(c2);

			const listA = await store.listConversations(tenantA.tenantId, {});
			expect(listA).toHaveLength(1);
			expect(listA[0]!.id).toBe(c1.id);

			const listB = await store.listConversations(tenantB.tenantId, {});
			expect(listB).toHaveLength(1);
			expect(listB[0]!.id).toBe(c2.id);
		});

		it('filters by status when specified', async () => {
			const store = freshStore();
			const active = makeConversation({
				tenantId: tenantA.tenantId,
				identity: tenantA,
			});
			const closed = makeConversation({
				tenantId: tenantA.tenantId,
				identity: tenantA,
			});
			closed.status = 'closed';
			await store.upsertConversation(active);
			await store.upsertConversation(closed);

			const activeList = await store.listConversations(tenantA.tenantId, {
				status: 'active',
			});
			expect(activeList).toHaveLength(1);
			expect(activeList[0]!.id).toBe(active.id);

			const closedList = await store.listConversations(tenantA.tenantId, {
				status: 'closed',
			});
			expect(closedList).toHaveLength(1);
			expect(closedList[0]!.id).toBe(closed.id);
		});

		it('respects limit and offset', async () => {
			const store = freshStore();
			for (let i = 0; i < 5; i++) {
				const c = makeConversation({
					tenantId: tenantA.tenantId,
					identity: tenantA,
				});
				c.lastActivityAt = 1000 + i;
				await store.upsertConversation(c);
			}
			const page1 = await store.listConversations(tenantA.tenantId, {
				limit: 2,
				offset: 0,
			});
			expect(page1).toHaveLength(2);

			const page2 = await store.listConversations(tenantA.tenantId, {
				limit: 3,
				offset: 2,
			});
			expect(page2).toHaveLength(3);
		});
	});

	describe('appendTurn + getTurns', () => {
		it('round-trips a turn', async () => {
			const store = freshStore();
			const turn = makeTurn({
				conversationId: 'conv-1',
				tenantId: tenantA.tenantId,
				identity: tenantA,
				input: { type: 'text', text: 'hello', receivedAt: 1 },
			});
			turn.assistantText = 'hi there';
			turn.outcome = { type: 'answered', confidence: 0.9 };

			await store.appendTurn(turn);
			const turns = await store.getTurns(tenantA.tenantId, 'conv-1');
			expect(turns).toHaveLength(1);
			expect(turns[0]!.id).toBe(turn.id);
			expect(turns[0]!.assistantText).toBe('hi there');
		});

		it('tenant A turns are invisible to tenant B', async () => {
			const store = freshStore();
			const turnA = makeTurn({
				conversationId: 'conv-1',
				tenantId: tenantA.tenantId,
				identity: tenantA,
				input: { type: 'text', text: 'a', receivedAt: 1 },
			});
			const turnB = makeTurn({
				conversationId: 'conv-1',
				tenantId: tenantB.tenantId,
				identity: tenantB,
				input: { type: 'text', text: 'b', receivedAt: 1 },
			});

			await store.appendTurn(turnA);
			await store.appendTurn(turnB);

			const aTurns = await store.getTurns(tenantA.tenantId, 'conv-1');
			expect(aTurns).toHaveLength(1);
			expect(aTurns[0]!.tenantId).toBe(tenantA.tenantId);

			const bTurns = await store.getTurns(tenantB.tenantId, 'conv-1');
			expect(bTurns).toHaveLength(1);
			expect(bTurns[0]!.tenantId).toBe(tenantB.tenantId);
		});

		it('filtering by after timestamp', async () => {
			const store = freshStore();
			for (let i = 1; i <= 5; i++) {
				const turn = makeTurn({
					id: `t${i}`,
					startedAt: i * 100,
					conversationId: 'conv-1',
					tenantId: tenantA.tenantId,
					identity: tenantA,
					input: { type: 'text', text: `msg${i}`, receivedAt: i * 100 },
				});
				await store.appendTurn(turn);
			}
			const later = await store.getTurns(tenantA.tenantId, 'conv-1', {
				after: 300,
			});
			expect(later).toHaveLength(2);
			expect(later.map((t) => t.id)).toEqual(['t4', 't5']);
		});
	});

	describe('outcomesRollup', () => {
		it('counts outcomes across turns in the time range', async () => {
			const store = freshStore();
			const baseTime = 10_000;

			const make = (offset: number, outcomeType: string) => {
				const turn = makeTurn({
					conversationId: `c${offset}`,
					tenantId: tenantA.tenantId,
					identity: tenantA,
					input: {
						type: 'text',
						text: 'x',
						receivedAt: baseTime + offset,
					},
					startedAt: baseTime + offset,
				});
				if (outcomeType === 'answered')
					turn.outcome = { type: 'answered', confidence: 0.8 };
				else if (outcomeType === 'handed_off')
					turn.outcome = {
						type: 'handed_off',
						reason: 'low_confidence',
						summary: 'help',
					};
				else if (outcomeType === 'refused')
					turn.outcome = {
						type: 'refused',
						class: 'off_topic',
						reason: 'nope',
					};
				else if (outcomeType === 'tool_error')
					turn.outcome = {
						type: 'tool_error',
						toolName: 'lookup',
						recoverable: false,
					};
				return turn;
			};

			await store.appendTurn(make(1, 'answered'));
			await store.appendTurn(make(2, 'answered'));
			await store.appendTurn(make(3, 'handed_off'));
			await store.appendTurn(make(4, 'refused'));
			await store.appendTurn(make(5, 'tool_error'));
			// Turn outside range:
			const outside = makeTurn({
				conversationId: 'outside',
				tenantId: tenantA.tenantId,
				identity: tenantA,
				input: { type: 'text', text: 'x', receivedAt: 1 },
				startedAt: 1,
			});
			outside.outcome = { type: 'answered', confidence: 0.9 };
			await store.appendTurn(outside);

			const rollup = await store.outcomesRollup(tenantA.tenantId, {
				start: baseTime,
				end: baseTime + 100,
			});

			expect(rollup.totalConversations).toBe(5);
			expect(rollup.totalTurns).toBe(5);
			expect(rollup.resolved).toBe(2);
			expect(rollup.escalated).toBe(1);
			expect(rollup.refused).toBe(1);
			expect(rollup.toolError).toBe(1);
		});

		it('returns empty rollup for tenant with no turns', async () => {
			const store = freshStore();
			const rollup = await store.outcomesRollup(tenantA.tenantId, {
				start: 0,
				end: Date.now(),
			});
			expect(rollup.totalConversations).toBe(0);
			expect(rollup.totalTurns).toBe(0);
		});

		it('ignores in_progress turns', async () => {
			const store = freshStore();
			const turn = makeTurn({
				conversationId: 'c1',
				tenantId: tenantA.tenantId,
				identity: tenantA,
				input: { type: 'text', text: 'x', receivedAt: 100 },
				startedAt: 100,
			});
			await store.appendTurn(turn);

			const rollup = await store.outcomesRollup(tenantA.tenantId, {
				start: 0,
				end: 200,
			});
			expect(rollup.totalTurns).toBe(0);
		});
	});
});
