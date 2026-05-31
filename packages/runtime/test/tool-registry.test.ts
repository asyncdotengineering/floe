/**
 * Boundary tests for `ToolRegistry`. End-to-end coverage:
 *   - host turn includes convo.tools, conditionally flow-entry tools,
 *     conditionally the delegate tool
 *   - extraction turn includes convo.tools + node.tools + the submit
 *     tool (with retry-nudge variant when requested)
 *   - capture turn includes convo.tools + node.tools, NO auto-inject
 *   - harness presence enforced for coordinate mode
 *   - toolHooks (when set) flow through to adaptFloeTool
 */
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { createToolRegistry } from '../src/orchestrator/tool-registry.ts';
import { defineTool, defineExtractionNode, defineCaptureNode, defineFlow, defineReplyNode } from '../src/define.ts';
import type {
	AssistantConfig,
	ToolContext,
} from '../src/types.ts';
import type { ToolYieldSink } from '../src/tool-adapter.ts';

const noopSink: ToolYieldSink = { emitEvent: () => {}, setTransition: () => {} };
const noopCtxBuilder = (): ToolContext => ({
	session: {} as never,
	conv: {} as never,
	signal: new AbortController().signal,
});

function fakeConvo(overrides: Partial<AssistantConfig> = {}): AssistantConfig {
	return {
		name: 'test',
		systemPrompt: 's',
		mode: 'direct',
		...overrides,
	};
}

const echoTool = defineTool({
	name: 'echo',
	description: 'Echo the input.',
	parameters: v.object({ text: v.string() }),
	async execute(args) {
		return args.text;
	},
});

const lookupTool = defineTool({
	name: 'lookup',
	description: 'Look something up.',
	parameters: v.object({ id: v.string() }),
	async execute(args) {
		return { id: args.id };
	},
});

const dummyReplyNode = defineReplyNode({
	name: 'reply',
	prompt: 'reply',
	next: { kind: 'end', reason: 'done' },
});

describe('createToolRegistry — forHost', () => {
	it('returns convo.tools only when no flows + non-coordinate mode', () => {
		const convo = fakeConvo({ tools: [echoTool] });
		const reg = createToolRegistry({
			convo, ctxBuilder: noopCtxBuilder, sink: noopSink, isVoice: false, respondingTo: 'evt',
		});
		const tools = reg.forHost({ mode: 'direct', hasActiveFlow: false });
		expect(tools).toHaveLength(1);
		expect(tools[0]!.name).toBe('echo');
	});

	it('adds flow-entry tools when flows configured + no active flow', () => {
		const flow = defineFlow({
			name: 'support',
			description: 'Handle support requests.',
			startNode: () => dummyReplyNode,
		});
		const convo = fakeConvo({ tools: [echoTool], flows: [flow] });
		const reg = createToolRegistry({
			convo, ctxBuilder: noopCtxBuilder, sink: noopSink, isVoice: false, respondingTo: 'evt',
		});
		const tools = reg.forHost({ mode: 'direct', hasActiveFlow: false });
		const names = tools.map((t) => t.name);
		expect(names).toContain('echo');
		expect(names).toContain('enter_support');
	});

	it('SKIPS flow-entry tools when a flow is already active', () => {
		const flow = defineFlow({
			name: 'support',
			description: 'd',
			startNode: () => dummyReplyNode,
		});
		const convo = fakeConvo({ tools: [echoTool], flows: [flow] });
		const reg = createToolRegistry({
			convo, ctxBuilder: noopCtxBuilder, sink: noopSink, isVoice: false, respondingTo: 'evt',
		});
		const tools = reg.forHost({ mode: 'direct', hasActiveFlow: true });
		const names = tools.map((t) => t.name);
		expect(names).not.toContain('enter_support');
	});

	it('adds the delegate tool in coordinate mode when roles exist', () => {
		const convo = fakeConvo({
			roles: { specialist: { name: 'specialist', instructions: 'i' } },
		});
		const fakeHarness = { session: async () => ({}) } as never;
		const reg = createToolRegistry({
			convo, harness: fakeHarness, ctxBuilder: noopCtxBuilder, sink: noopSink,
			isVoice: false, respondingTo: 'evt',
		});
		const tools = reg.forHost({ mode: 'coordinate', hasActiveFlow: false });
		expect(tools.some((t) => t.name === 'delegate')).toBe(true);
	});

	it('throws when coordinate mode is used without harness', () => {
		const convo = fakeConvo({
			roles: { specialist: { name: 'specialist', instructions: 'i' } },
		});
		const reg = createToolRegistry({
			convo, ctxBuilder: noopCtxBuilder, sink: noopSink, isVoice: false, respondingTo: 'evt',
			// no harness
		});
		expect(() => reg.forHost({ mode: 'coordinate', hasActiveFlow: false })).toThrow(/harness/);
	});

	it('does NOT add delegate tool in non-coordinate modes even with roles', () => {
		const convo = fakeConvo({
			roles: { specialist: { name: 'specialist', instructions: 'i' } },
		});
		const reg = createToolRegistry({
			convo, ctxBuilder: noopCtxBuilder, sink: noopSink, isVoice: false, respondingTo: 'evt',
		});
		const tools = reg.forHost({ mode: 'direct', hasActiveFlow: false });
		expect(tools.some((t) => t.name === 'delegate')).toBe(false);
	});
});

describe('createToolRegistry — forExtraction', () => {
	it('includes convo.tools + node.tools + the submit_<slug>_data tool', () => {
		const node = defineExtractionNode({
			name: 'collect-order',
			prompt: 'Collect order id.',
			schema: v.object({ orderId: v.string() }),
			requiredFields: ['orderId'],
			tools: [lookupTool],
			async onComplete() { return { kind: 'end' }; },
		});
		const convo = fakeConvo({ tools: [echoTool] });
		const reg = createToolRegistry({
			convo, ctxBuilder: noopCtxBuilder, sink: noopSink, isVoice: false, respondingTo: 'evt',
		});
		const tools = reg.forExtraction({
			node, missingFields: ['orderId'], userMessage: 'I want to return ord_1',
		});
		const names = tools.map((t) => t.name);
		expect(names).toContain('echo');
		expect(names).toContain('lookup');
		expect(names).toContain('submit_collect_order_data');
	});

	it('retry-nudge variant produces a different tool body (description differs)', () => {
		const node = defineExtractionNode({
			name: 'collect-order',
			prompt: 'p',
			schema: v.object({ orderId: v.string() }),
			requiredFields: ['orderId'],
			async onComplete() { return { kind: 'end' }; },
		});
		const convo = fakeConvo();
		const reg = createToolRegistry({
			convo, ctxBuilder: noopCtxBuilder, sink: noopSink, isVoice: false, respondingTo: 'evt',
		});
		const base = reg.forExtraction({
			node, missingFields: ['orderId'], userMessage: 'the user said this',
		});
		const retry = reg.forExtraction({
			node, missingFields: ['orderId'], userMessage: 'the user said this', retryNudge: true,
		});
		const baseSubmit = base.find((t) => t.name === 'submit_collect_order_data');
		const retrySubmit = retry.find((t) => t.name === 'submit_collect_order_data');
		expect(baseSubmit).toBeDefined();
		expect(retrySubmit).toBeDefined();
		expect(retrySubmit!.description).not.toBe(baseSubmit!.description);
		expect(retrySubmit!.description).toMatch(/previous .* call .* produced no field values/i);
	});
});

describe('createToolRegistry — forCapture', () => {
	it('includes convo.tools + node.tools, NO auto-injected tools', () => {
		const node = defineCaptureNode({
			name: 'capture-yes-no',
			prompt: 'yes or no?',
			schema: v.object({ confirmed: v.boolean() }),
			tools: [lookupTool],
			async handler() { return { kind: 'end' }; },
		});
		const convo = fakeConvo({ tools: [echoTool] });
		const reg = createToolRegistry({
			convo, ctxBuilder: noopCtxBuilder, sink: noopSink, isVoice: false, respondingTo: 'evt',
		});
		const tools = reg.forCapture({ node });
		const names = tools.map((t) => t.name);
		expect(names).toContain('echo');
		expect(names).toContain('lookup');
		// No submit_*, no delegate, no enter_*
		expect(names.some((n) => n.startsWith('submit_') || n === 'delegate' || n.startsWith('enter_'))).toBe(false);
	});
});

describe('createToolRegistry — toolHooks passthrough', () => {
	it('threads convo.toolHooks into every adapted tool', async () => {
		const calls: string[] = [];
		const convo = fakeConvo({
			tools: [echoTool],
			toolHooks: {
				async beforeToolCall(ctx) {
					calls.push(`before:${ctx.toolName}`);
				},
			},
		});
		const reg = createToolRegistry({
			convo, ctxBuilder: noopCtxBuilder, sink: noopSink, isVoice: false, respondingTo: 'evt',
		});
		const [echo] = reg.forHost({ mode: 'direct', hasActiveFlow: false });
		await echo!.execute({ text: 'hi' }, new AbortController().signal);
		expect(calls).toEqual(['before:echo']);
	});
});
