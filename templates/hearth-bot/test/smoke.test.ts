/**
 * Smoke test for the hearth-bot template — the wiring stays correct
 * + the mocks come up + the roles+tools+knowledge constructs cleanly.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createHearthBot } from '../floe.config.ts';
import type { MountedMocks } from '../mocks.ts';

let booted: { mocks: MountedMocks; assistant: import('@floe/runtime').Assistant } | null = null;

afterAll(async () => {
	if (booted) await booted.mocks.stopAll();
});

describe('hearth-bot template — boot smoke', () => {
	it('creates an Assistant with the expected roles + mcp + knowledge', async () => {
		process.env.HEARTH_MOCK_SUBS_PORT = String(45101);
		process.env.HEARTH_MOCK_ORDER_PORT = String(45102);
		booted = await createHearthBot();

		expect(booted.assistant.config.name).toBe('hearth-bot');
		expect(booted.assistant.config.mode).toBe('coordinate');
		expect(Object.keys(booted.assistant.config.roles ?? {}).sort()).toEqual([
			'box-issue',
			'retention',
		]);
		expect(booted.assistant.config.mcp?.map((m) => m.name).sort()).toEqual([
			'order',
			'subscription',
		]);
		expect(booted.mocks.subscription.url).toContain(':45101');
		expect(booted.mocks.order.url).toContain(':45102');
	});
});
