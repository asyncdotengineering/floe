import { describe, expect, it } from 'vitest';
import { makeTurn, type Turn } from '../src/turn.ts';
import type { Identity } from '../src/identity.ts';

const identity: Identity = { tenantId: 'tenant-1', userId: 'alice' };

describe('Turn — factory + shape', () => {
	it('makeTurn produces an in_progress Turn with zeroed mutable fields', () => {
		const turn = makeTurn({
			conversationId: 'conv-1',
			tenantId: 'tenant-1',
			identity,
			input: { type: 'text', text: 'hi', receivedAt: 1000 },
		});
		expect(turn.id).toMatch(/^trn_/);
		expect(turn.conversationId).toBe('conv-1');
		expect(turn.tenantId).toBe('tenant-1');
		expect(turn.input.text).toBe('hi');
		expect(turn.retrieval.chunks).toEqual([]);
		expect(turn.retrieval.strongSignal).toBe(false);
		expect(turn.toolCalls).toEqual([]);
		expect(turn.assistantText).toBeNull();
		expect(turn.outcome.type).toBe('in_progress');
		expect(turn.endedAt).toBeNull();
		expect(turn.metrics.tokensIn).toBe(0);
		expect(turn.metrics.stages.llmMs).toBe(0);
	});

	it('makeTurn honors a caller-provided id and startedAt', () => {
		const turn = makeTurn({
			id: 'custom-id',
			startedAt: 12345,
			conversationId: 'c',
			tenantId: 't',
			identity,
			input: { type: 'text', text: 'x', receivedAt: 12345 },
		});
		expect(turn.id).toBe('custom-id');
		expect(turn.startedAt).toBe(12345);
	});

	it('two Turn factories produce isolated metrics objects (no shared mutation)', () => {
		const a = makeTurn({
			conversationId: 'c',
			tenantId: 't',
			identity,
			input: { type: 'text', text: 'x', receivedAt: 0 },
		});
		const b = makeTurn({
			conversationId: 'c',
			tenantId: 't',
			identity,
			input: { type: 'text', text: 'y', receivedAt: 0 },
		});
		a.metrics.tokensIn = 100;
		a.metrics.stages.llmMs = 200;
		expect(b.metrics.tokensIn).toBe(0);
		expect(b.metrics.stages.llmMs).toBe(0);
	});

	it('Turn round-trips through JSON serialization', () => {
		const turn = makeTurn({
			conversationId: 'c',
			tenantId: 't',
			identity,
			input: { type: 'text', text: 'hi', receivedAt: 1 },
		});
		turn.assistantText = 'hello';
		turn.toolCalls = [
			{ name: 'lookup', args: { x: 1 }, result: { ok: true }, startedAt: 1, endedAt: 2 },
		];
		turn.outcome = { type: 'answered', confidence: 0.87 };
		turn.endedAt = 1000;
		const json = JSON.stringify(turn);
		const restored = JSON.parse(json) as Turn;
		expect(restored.assistantText).toBe('hello');
		expect(restored.toolCalls).toHaveLength(1);
		expect(restored.toolCalls[0]!.name).toBe('lookup');
		expect(restored.outcome.type).toBe('answered');
		if (restored.outcome.type === 'answered') {
			expect(restored.outcome.confidence).toBe(0.87);
		}
		expect(restored.endedAt).toBe(1000);
	});

	it('TurnOutcome discriminated union narrows correctly', () => {
		const turn = makeTurn({
			conversationId: 'c',
			tenantId: 't',
			identity,
			input: { type: 'text', text: 'x', receivedAt: 0 },
		});
		turn.outcome = {
			type: 'handed_off',
			reason: 'low_confidence',
			summary: 'user needs human help',
			assignee: 'billing-team',
		};
		if (turn.outcome.type === 'handed_off') {
			expect(turn.outcome.reason).toBe('low_confidence');
			expect(turn.outcome.assignee).toBe('billing-team');
		} else {
			throw new Error('outcome type narrowing failed');
		}
	});

	it('persistError slot exists for retry-or-DLQ path (per §3.2 fix)', () => {
		const turn = makeTurn({
			conversationId: 'c',
			tenantId: 't',
			identity,
			input: { type: 'text', text: 'x', receivedAt: 0 },
		});
		turn.metrics.persistError = 'turso write timed out';
		expect(turn.metrics.persistError).toBe('turso write timed out');
	});
});
