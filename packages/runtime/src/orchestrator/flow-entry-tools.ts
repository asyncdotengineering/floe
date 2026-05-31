/**
 * Auto-injected flow-entry tools.
 *
 * For every Flow on the Assistant config, expose one LLM-callable tool
 * named `enter_<flow_slug>`. The LLM decides when the user's intent
 * matches a flow and calls the tool. The handler yields a `flow_enter`
 * transition; the orchestrator captures it via `ToolYieldSink`, applies
 * it (sets `state.activeFlow`), and continues the same-turn loop so the
 * flow's start node executes immediately.
 *
 * This is the canonical 2026 pattern: flows-as-tools. Multilingual by
 * construction — the LLM understands intent in any language, so there's
 * no regex / keyword matcher to maintain. See `docs/PROCEDURE-VS-SKILL.md`
 * (forthcoming flow-entry note) for the design rationale.
 */
import * as v from 'valibot';
import type { FloeTool, Flow, Transition } from '../types.ts';

export function createFlowEntryTools(flows: readonly Flow[]): FloeTool[] {
	return flows.map((flow) => {
		const toolName = `enter_${slugify(flow.name)}`;
		const description =
			(flow.description ?? `Start the ${flow.name} flow.`) +
			"\n\nCall this when the user's intent matches this flow. Pass any " +
			'structured data you extracted from the user message (order IDs, ' +
			'product names, customer details) on the `args` field. The flow\'s ' +
			'first step will produce the user-facing reply; do NOT also write ' +
			'a chat reply alongside the tool call.';
		return {
			name: toolName,
			description,
			parameters: v.object({
				args: v.optional(
					v.record(v.string(), v.any()),
				),
			}),
			async *execute(input): AsyncGenerator<Transition | string> {
				const raw = (input as { args?: Record<string, unknown> })?.args;
				const args = isPlainRecord(raw) ? raw : {};
				yield { kind: 'flow_enter', flow, args } satisfies Transition;
				yield `Entered flow "${flow.name}". The flow's first step will continue.`;
			},
		};
	});
}

function slugify(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}
