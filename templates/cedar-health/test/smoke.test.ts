/**
 * Smoke test for cedar-health: the Assistant constructs cleanly, the
 * mock MCP servers come up, the emergency-guard validator is wired
 * FIRST in the validators list.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createCedarHealth } from '../floe.config.ts';
import type { MountedMocks } from '../mocks.ts';

let booted: { mocks: MountedMocks; assistant: import('@floe/runtime').Assistant } | null = null;

afterAll(async () => {
	if (booted) await booted.mocks.stopAll();
});

describe('cedar-health template — boot smoke', () => {
	it('creates an Assistant with all 3 roles + emergency guard FIRST', async () => {
		process.env.CEDAR_MOCK_FHIR_PORT = String(45201);
		process.env.CEDAR_MOCK_RX_PORT = String(45202);
		process.env.CEDAR_MOCK_BILLING_PORT = String(45203);
		booted = await createCedarHealth();

		expect(booted.assistant.config.name).toBe('cedar-health');
		expect(booted.assistant.config.mode).toBe('coordinate');
		expect(Object.keys(booted.assistant.config.roles ?? {}).sort()).toEqual([
			'billing',
			'scheduler',
			'triage-router',
		]);
		expect(booted.assistant.config.mcp?.map((m) => m.name).sort()).toEqual([
			'billing',
			'patient_fhir',
			'rx',
		]);

		// Critical wiring assertion: the emergency guard MUST be first.
		// If a future edit reorders validators, this test catches it.
		const validators = booted.assistant.config.validators ?? [];
		expect(validators[0]?.name).toBe('emergency-keyword-guard');
		expect(validators[0]?.phase).toBe('preLLM');
	});
});
