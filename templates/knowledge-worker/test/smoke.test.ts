/**
 * Smoke test for the knowledge-worker template — Assistant constructs
 * with 3 roles + 4 MCPs, mocks come up, memory + knowledge wired.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createKnowledgeWorker } from '../floe.config.ts';
import type { MountedMocks } from '../mocks.ts';

let booted: { mocks: MountedMocks; assistant: import('@floe/runtime').Assistant } | null = null;

afterAll(async () => {
	if (booted) await booted.mocks.stopAll();
});

describe('knowledge-worker template — boot smoke', () => {
	it('createKnowledgeWorker() returns an Assistant + 4 mounted mocks', async () => {
		process.env.KW_MOCK_NOTION_PORT = String(45301);
		process.env.KW_MOCK_LINEAR_PORT = String(45302);
		process.env.KW_MOCK_CALENDAR_PORT = String(45303);
		process.env.KW_MOCK_EMAIL_PORT = String(45304);
		booted = await createKnowledgeWorker();
		expect(booted.assistant.config.name).toBe('knowledge-worker');
		expect(booted.assistant.config.mode).toBe('coordinate');
		expect(Object.keys(booted.assistant.config.roles ?? {}).sort()).toEqual([
			'drafter',
			'researcher',
			'summarizer',
		]);
		expect(booted.assistant.config.mcp?.map((m) => m.name).sort()).toEqual([
			'calendar',
			'email',
			'linear',
			'notion',
		]);
	});

	it('memory + knowledge configured (preload generous + extract ingest)', async () => {
		if (!booted) throw new Error('boot first');
		const mem = booted.assistant.config.memory;
		expect(mem && mem !== false ? mem.preload?.maxTokens : null).toBe(1200);
		expect(mem && mem !== false ? mem.ingest?.strategy : null).toBe('extract');
		const k = booted.assistant.config.knowledge;
		expect(Array.isArray(k) && k.length).toBe(1);
	});
});
