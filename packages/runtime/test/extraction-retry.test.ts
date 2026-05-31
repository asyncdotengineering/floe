/**
 * Unit tests for the extraction-tool hardening helpers:
 *   - createExtractionSubmitTool() inlines `userMessage` into the description
 *     and emits a `retryNudge` block when escalating
 *   - isEmptySubmission() correctly detects no-progress submissions
 */
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
	createExtractionSubmitTool,
	isEmptySubmission,
} from '../src/orchestrator/extraction.ts';
import { defineExtractionNode } from '../src/define.ts';
import type { Transition } from '../src/types.ts';

const orderSchema = v.object({
	orderId: v.string(),
	reason: v.string(),
});

const node = defineExtractionNode({
	name: 'collect-order',
	schema: orderSchema,
	requiredFields: ['orderId', 'reason'],
	async onComplete() {
		return { kind: 'end' } as Transition;
	},
});

describe('createExtractionSubmitTool — userMessage inlining', () => {
	it('embeds the user message verbatim in the description', () => {
		const tool = createExtractionSubmitTool(node, ['orderId', 'reason'], {
			userMessage: 'I want to return ord_2240 because the fit was wrong.',
		});
		expect(tool.description).toContain('user\'s latest message');
		expect(tool.description).toContain('ord_2240');
		expect(tool.description).toContain('fit was wrong');
	});
	it('omits the user-message block when not provided', () => {
		const tool = createExtractionSubmitTool(node, ['orderId', 'reason']);
		expect(tool.description).not.toContain("user's latest message");
	});
	it('handles non-English messages verbatim (multilingual)', () => {
		const sinhalaMsg = 'මට ord_2240 ආපසු දීමට අවශ්‍යයි, ප්‍රමාණය නිවැරදි නොවීය';
		const tool = createExtractionSubmitTool(node, ['orderId', 'reason'], {
			userMessage: sinhalaMsg,
		});
		expect(tool.description).toContain('ord_2240');
		expect(tool.description).toContain(sinhalaMsg);
	});
});

describe('createExtractionSubmitTool — retry nudge', () => {
	it('appends the retry-nudge paragraph when retryNudge:true', () => {
		const tool = createExtractionSubmitTool(node, ['orderId', 'reason'], {
			userMessage: 'I want to return ord_2240 because the fit was wrong.',
			retryNudge: true,
		});
		expect(tool.description).toMatch(/previous submit call .* produced no field values/i);
		expect(tool.description).toMatch(/do NOT call this tool with empty/i);
	});
	it('does NOT append the nudge by default', () => {
		const tool = createExtractionSubmitTool(node, ['orderId', 'reason']);
		expect(tool.description).not.toMatch(/previous submit call/i);
	});
});

describe('isEmptySubmission', () => {
	it('true for {}', () => {
		expect(isEmptySubmission({})).toBe(true);
	});
	it('true for {field: null}', () => {
		expect(isEmptySubmission({ orderId: null })).toBe(true);
	});
	it('true for {field: undefined}', () => {
		expect(isEmptySubmission({ orderId: undefined })).toBe(true);
	});
	it('true for {field: "" } (whitespace-only)', () => {
		expect(isEmptySubmission({ orderId: '   ' })).toBe(true);
	});
	it('false for {field: "ord_1"}', () => {
		expect(isEmptySubmission({ orderId: 'ord_1' })).toBe(false);
	});
	it('false when at least ONE field has a real value', () => {
		expect(isEmptySubmission({ orderId: 'ord_1', reason: null })).toBe(false);
	});
	it('false for {field: 0} (zero is a valid value)', () => {
		expect(isEmptySubmission({ count: 0 })).toBe(false);
	});
	it('false for {field: false}', () => {
		expect(isEmptySubmission({ flag: false })).toBe(false);
	});
});
