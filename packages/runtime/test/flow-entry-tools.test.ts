/**
 * Unit tests for the flow-entry tool factory.
 */
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { createFlowEntryTools } from '../src/orchestrator/flow-entry-tools.ts';
import { defineComputeNode, defineFlow } from '../src/define.ts';

function makeFlow(name: string, description?: string) {
	const node = defineComputeNode({
		name: `${name}-start`,
		compute() {
			return { kind: 'end', reason: 'noop' };
		},
	});
	return defineFlow({ name, description: description ?? '', startNode: () => node });
}

describe('createFlowEntryTools', () => {
	it('returns one tool per flow with enter_ prefix and slugified name', () => {
		const tools = createFlowEntryTools([
			makeFlow('return', 'Process a customer return.'),
			makeFlow('track-order', 'Look up an order status.'),
			makeFlow('Refund Request', 'Issue a refund.'),
		]);
		expect(tools.map((t) => t.name)).toEqual([
			'enter_return',
			'enter_track_order',
			'enter_refund_request',
		]);
	});

	it('tool description embeds the flow description', () => {
		const tools = createFlowEntryTools([makeFlow('return', 'Process a customer return.')]);
		expect(tools[0]!.description).toContain('Process a customer return.');
		expect(tools[0]!.description).toContain('intent matches this flow');
	});

	it('execute yields a flow_enter transition with extracted args', async () => {
		const flow = makeFlow('return', 'Process a customer return.');
		const [tool] = createFlowEntryTools([flow]);
		const iter = tool!.execute(
			{ args: { orderId: 'ord_2240', reason: 'fit was wrong' } },
			{} as never,
		);
		const yields: unknown[] = [];
		for await (const v of iter as AsyncIterable<unknown>) yields.push(v);
		expect(yields).toHaveLength(2);
		const transition = yields[0] as Transition;
		expect(transition.kind).toBe('flow_enter');
		if (transition.kind !== 'flow_enter') throw new Error('not flow_enter');
		expect(transition.flow.name).toBe('return');
		expect(transition.args).toEqual({ orderId: 'ord_2240', reason: 'fit was wrong' });
		expect(typeof yields[1]).toBe('string');
		expect(yields[1] as string).toContain('Entered flow "return"');
	});

	it('execute handles missing args by yielding empty args object', async () => {
		const flow = makeFlow('return');
		const [tool] = createFlowEntryTools([flow]);
		const iter = tool!.execute({}, {} as never);
		const yields: unknown[] = [];
		for await (const v of iter as AsyncIterable<unknown>) yields.push(v);
		const t = yields[0] as Transition;
		if (t.kind !== 'flow_enter') throw new Error('not flow_enter');
		expect(t.args).toEqual({});
	});

	it('execute coerces non-object args field to empty object', async () => {
		const flow = makeFlow('return');
		const [tool] = createFlowEntryTools([flow]);
		const iter = tool!.execute({ args: 'not an object' }, {} as never);
		const yields: unknown[] = [];
		for await (const v of iter as AsyncIterable<unknown>) yields.push(v);
		const t = yields[0] as Transition;
		if (t.kind !== 'flow_enter') throw new Error('not flow_enter');
		expect(t.args).toEqual({});
	});

	it('parameters schema accepts an args record', () => {
		const flow = makeFlow('return');
		const [tool] = createFlowEntryTools([flow]);
		const parsed = v.safeParse(tool!.parameters, { args: { orderId: 'ord_1' } });
		expect(parsed.success).toBe(true);
	});
});
