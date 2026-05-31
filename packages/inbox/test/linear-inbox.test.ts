import { describe, expect, it } from 'vitest';
import { LinearInboxAdapter } from '../src/adapters/linear-inbox.ts';
import { makeTurn } from '../src/turn.ts';
import type { Identity } from '../src/identity.ts';

const identity: Identity = { tenantId: 't-1', userId: 'alice' };

describe('LinearInboxAdapter', () => {

	it('falls back to logging when LINEAR_API_KEY is missing', async () => {
		delete process.env.LINEAR_API_KEY;
		const adapter = new LinearInboxAdapter();
		const turn = makeTurn({
			conversationId: 'c-1',
			tenantId: 't-1',
			identity,
			input: { type: 'text', text: 'help', receivedAt: 1000 },
		});

		const result = await adapter.open({
			turn,
			summary: 'Needs escalation',
		});

		expect(result.ticketId).toMatch(/^linear-fallback-/);
		expect(result.source).toBe('log');
	});
});
