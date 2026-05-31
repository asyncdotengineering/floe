import { describe, expect, it } from 'vitest';
import {
	DEFAULT_LIFECYCLE,
	makeConversation,
	transitionConversationStatus,
	type Conversation,
} from '../src/conversation.ts';

const identity = { tenantId: 't1', userId: 'alice' };
const baseConv = (overrides: Partial<Conversation> = {}) => ({
	...makeConversation({ tenantId: 't1', identity, startedAt: 0 }),
	...overrides,
});

describe('Conversation — factory', () => {
	it('makeConversation produces an active conversation with zeroed outcomes', () => {
		const c = makeConversation({ tenantId: 't1', identity, startedAt: 1000 });
		expect(c.id).toMatch(/^conv_/);
		expect(c.status).toBe('active');
		expect(c.startedAt).toBe(1000);
		expect(c.lastActivityAt).toBe(1000);
		expect(c.turnCount).toBe(0);
		expect(c.outcomes.answered).toBe(0);
		expect(c.outcomes.escalated).toBe(0);
		expect(c.escalatedAt).toBeNull();
		expect(c.closedAt).toBeNull();
	});
});

describe('Conversation — transitions', () => {
	it('user_input updates lastActivityAt and resets idle → active', () => {
		const c = baseConv({ status: 'idle', lastActivityAt: 0 });
		const next = transitionConversationStatus(c, { type: 'user_input', at: 5000 });
		expect(next.status).toBe('active');
		expect(next.lastActivityAt).toBe(5000);
	});

	it('turn_complete answered increments outcomes + turnCount, stays active', () => {
		const c = baseConv();
		const next = transitionConversationStatus(c, {
			type: 'turn_complete',
			at: 1000,
			outcome: { type: 'answered', confidence: 0.9 },
		});
		expect(next.turnCount).toBe(1);
		expect(next.outcomes.answered).toBe(1);
		expect(next.status).toBe('active');
	});

	it('turn_complete handed_off flips to escalated and stamps escalatedAt', () => {
		const c = baseConv();
		const next = transitionConversationStatus(c, {
			type: 'turn_complete',
			at: 2000,
			outcome: {
				type: 'handed_off',
				reason: 'low_confidence',
				summary: 'human needed',
			},
		});
		expect(next.status).toBe('escalated');
		expect(next.escalatedAt).toBe(2000);
		expect(next.outcomes.escalated).toBe(1);
	});

	it('time_check after idleMs flips active → idle', () => {
		const c = baseConv({ status: 'active', lastActivityAt: 0 });
		const next = transitionConversationStatus(
			c,
			{ type: 'time_check', at: DEFAULT_LIFECYCLE.idleMs + 1 },
		);
		expect(next.status).toBe('idle');
	});

	it('time_check after abandonedMs flips idle → abandoned', () => {
		const c = baseConv({ status: 'idle', lastActivityAt: 0 });
		const next = transitionConversationStatus(
			c,
			{ type: 'time_check', at: DEFAULT_LIFECYCLE.abandonedMs + 1 },
		);
		expect(next.status).toBe('abandoned');
	});

	it('time_check does not regress escalated', () => {
		const c = baseConv({ status: 'escalated', lastActivityAt: 0, escalatedAt: 0 });
		const next = transitionConversationStatus(
			c,
			{ type: 'time_check', at: DEFAULT_LIFECYCLE.abandonedMs + 1 },
		);
		expect(next.status).toBe('escalated');
	});

	it('user_input re-opens an escalated conversation back to active', () => {
		const c = baseConv({ status: 'escalated', escalatedAt: 100 });
		const next = transitionConversationStatus(c, { type: 'user_input', at: 200 });
		expect(next.status).toBe('active');
		expect(next.lastActivityAt).toBe(200);
	});

	it('human_close → closed, stamps closedAt + resolvedAt if not already set', () => {
		const c = baseConv({ status: 'escalated' });
		const next = transitionConversationStatus(c, { type: 'human_close', at: 9999 });
		expect(next.status).toBe('closed');
		expect(next.closedAt).toBe(9999);
		expect(next.resolvedAt).toBe(9999);
	});

	it('closed is terminal — further events are no-ops', () => {
		const c = baseConv({ status: 'closed', closedAt: 100, resolvedAt: 100 });
		const next = transitionConversationStatus(c, { type: 'user_input', at: 200 });
		expect(next).toBe(c); // identity check — no mutation, no new object
	});

	it('transitions are pure — input not mutated', () => {
		const c = baseConv();
		const before = JSON.stringify(c);
		transitionConversationStatus(c, {
			type: 'turn_complete',
			at: 1,
			outcome: { type: 'answered', confidence: 0.5 },
		});
		expect(JSON.stringify(c)).toBe(before);
	});

	it('lifecycle overrides apply when caller passes a custom config', () => {
		const c = baseConv({ status: 'active', lastActivityAt: 0 });
		const next = transitionConversationStatus(
			c,
			{ type: 'time_check', at: 60_001 },
			{ idleMs: 60_000, abandonedMs: 600_000 },
		);
		expect(next.status).toBe('idle');
	});
});
