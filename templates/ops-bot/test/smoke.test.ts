/**
 * Smoke test for the ops-bot template. Verifies the Assistant
 * constructs cleanly, the mock MCP servers come up, and the wiring
 * doesn't throw at boot. Live LLM tests would require API keys —
 * this is the "the lights turn on" check.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createOpsBot } from '../floe.config.ts';
import type { MountedMocks } from '../mocks.ts';

let booted: { mocks: MountedMocks; assistant: import('@floe/runtime').Assistant } | null = null;

afterAll(async () => {
	if (booted) await booted.mocks.stopAll();
});

describe('ops-bot template — boot smoke', () => {
	it('createOpsBot() returns an Assistant + mounted mocks', async () => {
		// Bind to unique ports for this test run to avoid clashes
		process.env.OPS_MOCK_OKTA_PORT = String(45001);
		process.env.OPS_MOCK_NOTION_PORT = String(45002);
		process.env.OPS_MOCK_LINEAR_PORT = String(45003);
		booted = await createOpsBot();
		expect(booted.assistant.config.name).toBe('ops-bot');
		expect(booted.mocks.okta.url).toContain(':45001');
		expect(booted.mocks.notion.url).toContain(':45002');
		expect(booted.mocks.linear.url).toContain(':45003');
		expect(booted.assistant.config.mcp?.map((m) => m.name).sort()).toEqual([
			'linear',
			'notion',
			'okta',
		]);
	});
});
