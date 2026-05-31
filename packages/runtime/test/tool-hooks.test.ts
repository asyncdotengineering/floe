/**
 * End-to-end tests for Assistant-level tool hooks (beforeToolCall +
 * afterToolCall). Uses the faux LLM provider to script tool-calling
 * behavior deterministically — no real LLM cost.
 *
 * Covered:
 *   - beforeToolCall fires before execute
 *   - beforeToolCall.shortCircuit skips the tool entirely
 *   - beforeToolCall.modifiedArgs mutates the args the tool sees
 *   - afterToolCall fires after execute
 *   - afterToolCall.modifiedResult mutates what the LLM sees
 *   - afterToolCall sees execution errors AND can swallow them
 *   - hook errors are caught + logged, never fail the turn
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import {
	registerFloeFaux,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type FloeFauxHandle,
} from '../src/testing/faux.ts';
import { Assistant } from '../src/assistant.ts';
import { defineTool } from '../src/define.ts';

let faux: FloeFauxHandle | null = null;

afterEach(() => {
	if (faux) {
		faux.unregister();
		faux = null;
	}
});

/**
 * A simple tool the LLM will call; records every call for assertions.
 */
function makeRecordingTool() {
	const calls: Array<{ args: Record<string, unknown> }> = [];
	const tool = defineTool({
		name: 'lookup_order',
		description: 'Look up an order by id.',
		parameters: v.object({ orderId: v.string() }),
		async execute(args) {
			calls.push({ args });
			return { orderId: args.orderId, status: 'shipped' };
		},
	});
	return { tool, calls };
}

/**
 * Faux response that fires one tool call then a final text reply.
 * Tool result is consumed by the second response.
 */
function scriptToolCall(toolName: string, args: Record<string, unknown>, finalText: string) {
	return [
		fauxAssistantMessage([fauxToolCall(toolName, args)]),
		fauxAssistantMessage([fauxText(finalText)]),
	];
}

describe('Assistant.toolHooks — end-to-end with faux LLM', () => {
	it('beforeToolCall fires with the original args + ctx', async () => {
		const { tool, calls } = makeRecordingTool();
		const seen: Array<{ toolName: string; args: unknown }> = [];

		faux = registerFloeFaux({
			provider: 'tool-hooks-1',
			responses: scriptToolCall('lookup_order', { orderId: 'ord_42' }, 'Done.'),
		});

		const a = new Assistant({
			name: 't', systemPrompt: 'You look things up.', mode: 'direct',
			model: 'tool-hooks-1/test', sandbox: false,
			tools: [tool],
			toolHooks: {
				async beforeToolCall(ctx) {
					seen.push({ toolName: ctx.toolName, args: ctx.args });
				},
			},
		});

		await a.run('look up ord_42', { sessionId: 's-1' });
		expect(seen).toEqual([{ toolName: 'lookup_order', args: { orderId: 'ord_42' } }]);
		// Tool executed normally
		expect(calls).toEqual([{ args: { orderId: 'ord_42' } }]);
	});

	it('beforeToolCall.shortCircuit skips the tool entirely', async () => {
		const { tool, calls } = makeRecordingTool();

		faux = registerFloeFaux({
			provider: 'tool-hooks-2',
			responses: scriptToolCall('lookup_order', { orderId: 'ord_99' }, 'Got it.'),
		});

		const a = new Assistant({
			name: 't', systemPrompt: 's', mode: 'direct',
			model: 'tool-hooks-2/test', sandbox: false,
			tools: [tool],
			toolHooks: {
				async beforeToolCall(ctx) {
					if (ctx.toolName === 'lookup_order') {
						return { shortCircuit: { orderId: ctx.args.orderId, status: 'cached' } };
					}
				},
			},
		});

		await a.run('hi', { sessionId: 's-2' });
		expect(calls).toEqual([]); // tool NEVER ran
	});

	it('beforeToolCall.modifiedArgs mutates what the tool sees', async () => {
		const { tool, calls } = makeRecordingTool();

		faux = registerFloeFaux({
			provider: 'tool-hooks-3',
			responses: scriptToolCall('lookup_order', { orderId: 'ord_lower' }, 'done'),
		});

		const a = new Assistant({
			name: 't', systemPrompt: 's', mode: 'direct',
			model: 'tool-hooks-3/test', sandbox: false,
			tools: [tool],
			toolHooks: {
				async beforeToolCall(ctx) {
					if (ctx.toolName === 'lookup_order') {
						// Normalize: uppercase the order id
						return {
							modifiedArgs: {
								...ctx.args,
								orderId: String(ctx.args.orderId).toUpperCase(),
							},
						};
					}
				},
			},
		});

		await a.run('hi', { sessionId: 's-3' });
		expect(calls).toEqual([{ args: { orderId: 'ORD_LOWER' } }]);
	});

	it('afterToolCall fires with the result string + original args', async () => {
		const { tool } = makeRecordingTool();
		const seen: Array<{ toolName: string; result: string; error: unknown }> = [];

		faux = registerFloeFaux({
			provider: 'tool-hooks-4',
			responses: scriptToolCall('lookup_order', { orderId: 'ord_1' }, 'done'),
		});

		const a = new Assistant({
			name: 't', systemPrompt: 's', mode: 'direct',
			model: 'tool-hooks-4/test', sandbox: false,
			tools: [tool],
			toolHooks: {
				async afterToolCall(ctx) {
					seen.push({ toolName: ctx.toolName, result: ctx.result, error: ctx.error });
				},
			},
		});

		await a.run('hi', { sessionId: 's-4' });
		expect(seen).toHaveLength(1);
		expect(seen[0]!.toolName).toBe('lookup_order');
		expect(seen[0]!.result).toContain('shipped');
		expect(seen[0]!.error).toBeUndefined();
	});

	it('afterToolCall.modifiedResult swaps what the LLM sees', async () => {
		const { tool } = makeRecordingTool();
		// Capture the raw tool result that flowed past the hook (post-mutation)
		// by inspecting the second faux response's context. The shape of
		// tool messages varies by provider; the robust check is that the
		// modified text appears SOMEWHERE in the messages handed to the
		// model, and the original ('shipped') does not.
		let allLlmContext = '';

		faux = registerFloeFaux({
			provider: 'tool-hooks-5',
			responses: [
				fauxAssistantMessage([fauxToolCall('lookup_order', { orderId: 'x' })]),
				(ctx) => {
					allLlmContext = JSON.stringify(ctx.messages);
					return fauxAssistantMessage([fauxText('done')]);
				},
			],
		});

		const a = new Assistant({
			name: 't', systemPrompt: 's', mode: 'direct',
			model: 'tool-hooks-5/test', sandbox: false,
			tools: [tool],
			toolHooks: {
				async afterToolCall() {
					return { modifiedResult: '[REDACTED PII]' };
				},
			},
		});

		await a.run('hi', { sessionId: 's-5' });
		expect(allLlmContext).toContain('[REDACTED PII]');
		expect(allLlmContext).not.toContain('"status":"shipped"');
	});

	it('hook errors are caught and logged — tool still runs', async () => {
		const { tool, calls } = makeRecordingTool();
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		faux = registerFloeFaux({
			provider: 'tool-hooks-6',
			responses: scriptToolCall('lookup_order', { orderId: 'x' }, 'done'),
		});

		const a = new Assistant({
			name: 't', systemPrompt: 's', mode: 'direct',
			model: 'tool-hooks-6/test', sandbox: false,
			tools: [tool],
			toolHooks: {
				async beforeToolCall() {
					throw new Error('hook boom');
				},
			},
		});

		await a.run('hi', { sessionId: 's-6' });
		expect(calls).toHaveLength(1); // tool ran despite hook throwing
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining('beforeToolCall threw'),
		);
		warnSpy.mockRestore();
	});

	it('afterToolCall.modifiedResult swallows the tool error', async () => {
		const throwingTool = defineTool({
			name: 'broken',
			description: 'Always throws.',
			parameters: v.object({}),
			async execute() {
				throw new Error('tool ka-boom');
			},
		});

		faux = registerFloeFaux({
			provider: 'tool-hooks-7',
			responses: scriptToolCall('broken', {}, 'recovered'),
		});

		const a = new Assistant({
			name: 't', systemPrompt: 's', mode: 'direct',
			model: 'tool-hooks-7/test', sandbox: false,
			tools: [throwingTool],
			toolHooks: {
				async afterToolCall(ctx) {
					if (ctx.error !== undefined) {
						return { modifiedResult: 'gracefully degraded' };
					}
				},
			},
		});

		// Should NOT throw — afterToolCall swallowed the error.
		const out = await a.run('hi', { sessionId: 's-7' });
		expect(out.content).toContain('recovered'); // LLM saw the swap, finalized normally
	});

	it('no toolHooks configured → no overhead, no behavior change', async () => {
		const { tool, calls } = makeRecordingTool();

		faux = registerFloeFaux({
			provider: 'tool-hooks-8',
			responses: scriptToolCall('lookup_order', { orderId: 'ord_a' }, 'done'),
		});

		const a = new Assistant({
			name: 't', systemPrompt: 's', mode: 'direct',
			model: 'tool-hooks-8/test', sandbox: false,
			tools: [tool],
			// no toolHooks
		});

		await a.run('hi', { sessionId: 's-8' });
		expect(calls).toEqual([{ args: { orderId: 'ord_a' } }]);
	});
});
