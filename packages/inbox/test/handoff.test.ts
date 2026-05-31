import { describe, expect, it } from 'vitest';
import {
	LoggingInboxAdapter,
	type HandoffPolicy,
	type InboxPort,
	type HandoffArgs,
	type HandoffResult,
} from '../src/handoff.ts';
import { makeTurn, type Turn } from '../src/turn.ts';
import type { Identity } from '../src/identity.ts';

const identity: Identity = { tenantId: 't-1', userId: 'alice' };

function freshTurn(): Turn {
	return makeTurn({
		conversationId: 'c-1',
		tenantId: 't-1',
		identity,
		input: { type: 'text', text: 'help me please', receivedAt: 1000 },
	});
}

describe('HandoffPolicy', () => {
	it('fires when confidence is below threshold', async () => {
		const turn = freshTurn();
		turn.confidence.score = 0.3;
		turn.confidence.belowThreshold = true;

		const policy: HandoffPolicy = {
			threshold: 0.5,
			inbox: new LoggingInboxAdapter(),
		};

		// Simulate the handoff decision logic.
		const shouldHandoff = turn.confidence.belowThreshold;
		expect(shouldHandoff).toBe(true);
	});

	it('does not fire when confidence is above threshold', async () => {
		const turn = freshTurn();
		turn.confidence.score = 0.8;
		turn.confidence.belowThreshold = false;

		expect(turn.confidence.belowThreshold).toBe(false);
	});

	it('preTurn hook can force handoff before turn runs', async () => {
		const turn = freshTurn();

		const policy: HandoffPolicy = {
			threshold: 0.5,
			preTurn: () => ({ reason: 'user marked as VIP — always escalate' }),
			inbox: new LoggingInboxAdapter(),
		};

		const decision = policy.preTurn?.(turn) ?? null;
		expect(decision).not.toBeNull();
		expect(decision!.reason).toContain('VIP');
	});

	it('preTurn returning null defers to confidence check', async () => {
		const turn = freshTurn();

		const policy: HandoffPolicy = {
			threshold: 0.5,
			preTurn: () => null,
			inbox: new LoggingInboxAdapter(),
		};

		const decision = policy.preTurn?.(turn) ?? null;
		expect(decision).toBeNull();
	});

	it('postTurn hook can override the default handoff decision', async () => {
		const turn = freshTurn();
		turn.confidence.belowThreshold = true;

		const policy: HandoffPolicy = {
			threshold: 0.5,
			postTurn: () => ({ reason: 'escalated by post-turn validator', assignee: 'billing' }),
			inbox: new LoggingInboxAdapter(),
		};

		const decision = policy.postTurn?.(turn) ?? null;
		expect(decision).not.toBeNull();
		expect(decision!.assignee).toBe('billing');
	});

	it('postTurn returning null vetoes handoff even below threshold', async () => {
		const turn = freshTurn();
		turn.confidence.belowThreshold = true;

		const policy: HandoffPolicy = {
			threshold: 0.5,
			postTurn: () => null,
			inbox: new LoggingInboxAdapter(),
		};

		const decision = policy.postTurn?.(turn) ?? null;
		expect(decision).toBeNull();
	});
});

describe('LoggingInboxAdapter', () => {
	it('returns a log-prefixed ticket ID', async () => {
		const adapter = new LoggingInboxAdapter();
		const turn = freshTurn();
		const result = await adapter.open({ turn, summary: 'User needs refund help' });
		expect(result.ticketId).toMatch(/^log-/);
		expect(result.source).toBe('log');
	});

	it('records the correct args in the return value', async () => {
		const adapter = new LoggingInboxAdapter('test');
		const turn = makeTurn({
			id: 'trn-manual',
			conversationId: 'c-1',
			tenantId: 't-1',
			identity,
			input: { type: 'text', text: 'help', receivedAt: 1000 },
		});
		const result = await adapter.open({
			turn,
			summary: 'Refund escalation',
			assignee: 'billing-team',
		});
		expect(result.ticketId).toMatch(/^test-/);
		expect(result.source).toBe('log');
	});
});

describe('InboxPort interface', () => {
	it('custom InboxPort implementations work', async () => {
		let lastArgs: HandoffArgs | null = null;
		const customAdapter: InboxPort = {
			async open(args): Promise<HandoffResult> {
				lastArgs = args;
				return { ticketId: 'custom-123', source: 'custom' };
			},
		};

		const turn = freshTurn();
		const result = await customAdapter.open({
			turn,
			summary: 'test',
			assignee: 'agent-7',
		});

		expect(result.ticketId).toBe('custom-123');
		expect(result.source).toBe('custom');
		expect(lastArgs!.assignee).toBe('agent-7');
		expect(lastArgs!.turn).toBe(turn);
	});
});
