/**
 * Unit tests for the extraction-node primitives (orchestrator/extraction.ts).
 */
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
	computeMissingFields,
	createExtractionSubmitTool,
	mergeExtractionData,
} from '../src/orchestrator/extraction.ts';
import { isExtractionNode } from '../src/orchestrator/node-kinds.ts';
import {
	defineComputeNode,
	defineExtractionNode,
} from '../src/define.ts';
import type { Transition } from '../src/types.ts';

const orderSchema = v.object({
	orderId: v.string(),
	reason: v.string(),
});

describe('defineExtractionNode', () => {
	it('produces an ExtractionNode with kind set + schema preserved', () => {
		const node = defineExtractionNode({
			name: 'collect-order',
			prompt: 'Ask for order ID and reason.',
			schema: orderSchema,
			requiredFields: ['orderId', 'reason'],
			async onComplete() {
				return { kind: 'end' } as Transition;
			},
		});
		expect(node.kind).toBe('extraction');
		expect(node.name).toBe('collect-order');
		expect(node.prompt).toBe('Ask for order ID and reason.');
		expect(node.schema).toBe(orderSchema);
		expect(node.requiredFields).toEqual(['orderId', 'reason']);
	});
});

describe('isExtractionNode', () => {
	it('true for ExtractionNode instances', () => {
		const node = defineExtractionNode({
			name: 'n',
			schema: orderSchema,
			async onComplete() {
				return { kind: 'end' } as Transition;
			},
		});
		expect(isExtractionNode(node)).toBe(true);
	});
	it('false for ComputeNode', () => {
		const node = defineComputeNode({
			name: 'n',
			compute() {
				return { kind: 'end' };
			},
		});
		expect(isExtractionNode(node)).toBe(false);
	});
	it('false for null / undefined', () => {
		expect(isExtractionNode(null)).toBe(false);
		expect(isExtractionNode(undefined)).toBe(false);
	});
});

describe('mergeExtractionData', () => {
	it('merges new keys into existing data', () => {
		expect(mergeExtractionData({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
	});
	it('overwrites existing keys with new non-null values', () => {
		expect(mergeExtractionData({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
	});
	it('skips null/undefined incoming values (never erases prior data)', () => {
		expect(mergeExtractionData({ a: 1, b: 2 }, { a: null, b: undefined, c: 3 })).toEqual({
			a: 1,
			b: 2,
			c: 3,
		});
	});
	it('skips whitespace-only strings (treats as not submitted)', () => {
		expect(mergeExtractionData({ a: 'x' }, { a: '   ' })).toEqual({ a: 'x' });
	});
	it('preserves zero / false / arrays / objects as real values', () => {
		expect(
			mergeExtractionData({}, { n: 0, b: false, arr: [], obj: {} }),
		).toEqual({ n: 0, b: false, arr: [], obj: {} });
	});
});

describe('computeMissingFields', () => {
	function makeNode(required?: string[]) {
		return defineExtractionNode({
			name: 'n',
			schema: orderSchema,
			...(required ? { requiredFields: required as readonly (keyof v.InferOutput<typeof orderSchema> & string)[] } : {}),
			async onComplete() {
				return { kind: 'end' } as Transition;
			},
		});
	}
	it('returns all required fields when nothing collected', () => {
		expect(computeMissingFields(makeNode(['orderId', 'reason']), {})).toEqual(['orderId', 'reason']);
	});
	it('returns only fields still missing', () => {
		expect(
			computeMissingFields(makeNode(['orderId', 'reason']), { orderId: 'ord_1' }),
		).toEqual(['reason']);
	});
	it('returns empty when all required collected', () => {
		expect(
			computeMissingFields(
				makeNode(['orderId', 'reason']),
				{ orderId: 'ord_1', reason: 'fit' },
			),
		).toEqual([]);
	});
	it('infers required fields from schema when requiredFields omitted', () => {
		const node = defineExtractionNode({
			name: 'n',
			schema: v.object({
				required: v.string(),
				alsoRequired: v.string(),
				optional: v.optional(v.string()),
			}),
			async onComplete() {
				return { kind: 'end' } as Transition;
			},
		});
		expect(computeMissingFields(node, {})).toEqual(['required', 'alsoRequired']);
	});
});

describe('createExtractionSubmitTool', () => {
	const node = defineExtractionNode({
		name: 'collect-order',
		schema: orderSchema,
		requiredFields: ['orderId', 'reason'],
		async onComplete() {
			return { kind: 'end' } as Transition;
		},
	});

	it('names the tool with submit_<slug>_data convention', () => {
		const tool = createExtractionSubmitTool(node, ['orderId', 'reason']);
		expect(tool.name).toBe('submit_collect_order_data');
	});

	it('embeds the missing-field list in the tool description', () => {
		const tool = createExtractionSubmitTool(node, ['reason']);
		expect(tool.description).toContain('Still needed: reason');
		expect(tool.description).toContain('Call this every time you learn a new field value');
	});

	it('execute yields an extraction_submission transition + result string', async () => {
		const tool = createExtractionSubmitTool(node, ['orderId', 'reason']);
		const iter = tool.execute(
			{ orderId: 'ord_2240', reason: 'fit was wrong' },
			{} as never,
		);
		const yields: unknown[] = [];
		for await (const y of iter as AsyncIterable<unknown>) yields.push(y);
		expect(yields).toHaveLength(2);
		const t = yields[0] as Transition;
		expect(t.kind).toBe('extraction_submission');
		if (t.kind !== 'extraction_submission') throw new Error('not extraction_submission');
		expect(t.node.name).toBe('collect-order');
		expect(t.args).toEqual({ orderId: 'ord_2240', reason: 'fit was wrong' });
		expect(typeof yields[1]).toBe('string');
	});

	it('execute coerces non-object input to empty args', async () => {
		const tool = createExtractionSubmitTool(node, ['orderId', 'reason']);
		const iter = tool.execute('not-an-object' as never, {} as never);
		const yields: unknown[] = [];
		for await (const y of iter as AsyncIterable<unknown>) yields.push(y);
		const t = yields[0] as Transition;
		if (t.kind !== 'extraction_submission') throw new Error('not extraction_submission');
		expect(t.args).toEqual({});
	});

	it('parameters schema accepts partial / nullable submissions', () => {
		const tool = createExtractionSubmitTool(node, ['reason']);
		const r1 = v.safeParse(tool.parameters as v.GenericSchema, { orderId: 'ord_1' });
		expect(r1.success).toBe(true);
		const r2 = v.safeParse(tool.parameters as v.GenericSchema, { orderId: 'ord_1', reason: null });
		expect(r2.success).toBe(true);
		const r3 = v.safeParse(tool.parameters as v.GenericSchema, {});
		expect(r3.success).toBe(true);
	});
});
