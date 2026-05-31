/**
 * `ToolRegistry` — single boundary that owns Floe→Flue tool assembly.
 *
 * Before: four sites in `respond.ts` each rebuilt the same toolset
 * incantation:
 *
 *   convo.tools.map(t => adaptFloeTool(t, ctxBuilder, toolSink,
 *     { voice: isVoice, respondingTo, hooks: convo.toolHooks })),
 *   + node.tools (where applicable)
 *   + auto-injected tools (flow-entry, delegate, extraction-submit)
 *
 * Each turn kind composed its own union of those layers; the retry
 * path in extraction did it a second time inside the same function.
 * Adding a new auto-injected tool (or a new node kind) meant
 * duplicating the ceremony again.
 *
 * After: the registry is created once at the start of `respond()` and
 * captures all per-turn invariants — `convo`, the harness for
 * delegate, the ctx builder, the sink, voice flag, respondingTo,
 * toolHooks. Each turn kind asks for its toolset by name:
 *
 *   registry.forHost({ mode, hasActiveFlow })
 *   registry.forExtraction({ node, missingFields, userMessage, retryNudge })
 *   registry.forCapture({ node })
 *
 * The registry handles `adaptFloeTool` calls + auto-injected-tool
 * composition + voice/respondingTo/hooks passthrough internally.
 * Callers pass strings + booleans, not the full FloeTool plumbing.
 *
 * What this hides:
 *   - the adaptFloeTool() ceremony (~5 fields per call × 4+ sites)
 *   - the flow-entry-tools / delegate-tool / extraction-submit-tool
 *     composition rules (which tool goes in which turn kind)
 *   - the toolHooks passthrough
 *   - the voice-mode interim-message flag
 *   - the per-turn extraction retry-nudge variant
 *
 * Reply turns intentionally use `tools: []` (no tools allowed), so
 * the registry has no `forReply()` method — callers just pass `[]`.
 */
import type { FlueHarness, ToolDef } from '@flue/runtime';
import type {
	AssistantConfig,
	AssistantMode,
	CaptureNode,
	ExtractionNode,
	FloeTool,
	ToolContext,
} from '../types.ts';
import { adaptFloeTool, type ToolYieldSink } from '../tool-adapter.ts';
import { createDelegateTool } from './delegate-tool.ts';
import { createFlowEntryTools } from './flow-entry-tools.ts';
import { createExtractionSubmitTool } from './extraction.ts';

export interface ToolRegistryArgs {
	convo: AssistantConfig;
	/**
	 * Only required for the host turn when `mode === 'coordinate'` (the
	 * delegate tool spawns child sessions on the harness). Extraction
	 * and capture turns don't need it. Pass `undefined` from those
	 * sites.
	 */
	harness?: FlueHarness;
	/** Builds the per-turn ToolContext (session, conv view, signal). */
	ctxBuilder: () => ToolContext;
	/** Sink for AssistantOutputEvents + Transitions yielded by tools. */
	sink: ToolYieldSink;
	/** Voice channel hint — toggles the interim-message timer in tools. */
	isVoice: boolean;
	/** ID of the user event this turn is responding to (for event correlation). */
	respondingTo: string;
}

export interface HostToolsetArgs {
	/** Coordination mode — `'coordinate'` adds the `delegate` tool when roles exist. */
	mode: AssistantMode;
	/**
	 * Whether a flow is currently active. When `false`, flow-entry tools
	 * (`enter_<flow_slug>`) are exposed so the LLM can route into a flow.
	 * When `true`, they're hidden — switching flows mid-flow is disallowed.
	 */
	hasActiveFlow: boolean;
}

export interface ExtractionToolsetArgs {
	node: ExtractionNode;
	/**
	 * Names of required fields that haven't been collected yet. The
	 * submit tool is built with this list so the LLM sees exactly what
	 * remains.
	 */
	missingFields: readonly string[];
	/**
	 * Current user message — inlined verbatim into the submit tool's
	 * description (multilingual by construction; no regex hints needed).
	 */
	userMessage: string;
	/**
	 * When `true`, builds the retry-nudge variant of the submit tool.
	 * Used after a no-progress submit to push the LLM to extract from
	 * the user's message instead of asking again. Default `false`.
	 */
	retryNudge?: boolean;
}

export interface CaptureToolsetArgs {
	node: CaptureNode;
}

export interface ToolRegistry {
	/**
	 * Host turn (no active flow OR coordination/broadcast modes). Builds:
	 *   - convo.tools (user-defined tools)
	 *   - flow-entry tools (if `!hasActiveFlow` and `convo.flows` set)
	 *   - delegate tool (if `mode === 'coordinate'` and `convo.roles` non-empty)
	 */
	forHost(args: HostToolsetArgs): ToolDef[];
	/**
	 * Extraction turn. Builds:
	 *   - convo.tools
	 *   - node.tools (node-specific)
	 *   - the submit_<slug>_data tool (initial or retry-nudge variant)
	 */
	forExtraction(args: ExtractionToolsetArgs): ToolDef[];
	/**
	 * Capture turn. Builds:
	 *   - convo.tools
	 *   - node.tools
	 *
	 * (Capture nodes don't auto-inject any tool; the `result` schema is
	 * the contract.)
	 */
	forCapture(args: CaptureToolsetArgs): ToolDef[];
}

export function createToolRegistry(args: ToolRegistryArgs): ToolRegistry {
	const { convo, harness, ctxBuilder, sink, isVoice, respondingTo } = args;

	// Capture the adapt-options object once; every adapt call uses the
	// same shape. This is the de-duplication that motivated the registry.
	const adaptOpts = {
		voice: isVoice,
		respondingTo,
		...(convo.toolHooks ? { hooks: convo.toolHooks } : {}),
	};

	const adapt = (tool: FloeTool): ToolDef =>
		adaptFloeTool(tool, ctxBuilder, sink, adaptOpts);

	return {
		forHost({ mode, hasActiveFlow }) {
			const out: ToolDef[] = (convo.tools ?? []).map(adapt);
			if (convo.flows && convo.flows.length > 0 && !hasActiveFlow) {
				for (const flowTool of createFlowEntryTools(convo.flows)) {
					out.push(adapt(flowTool));
				}
			}
			if (mode === 'coordinate' && convo.roles && Object.keys(convo.roles).length > 0) {
				if (!harness) {
					throw new Error(
						'[floe:tool-registry] forHost({mode:"coordinate"}) requires ' +
							'`harness` on ToolRegistryArgs to build the delegate tool.',
					);
				}
				out.push(createDelegateTool({ harness, roles: convo.roles }));
			}
			return out;
		},

		forExtraction({ node, missingFields, userMessage, retryNudge }) {
			const out: ToolDef[] = [];
			for (const t of convo.tools ?? []) out.push(adapt(t));
			for (const t of node.tools ?? []) out.push(adapt(t));
			out.push(
				adapt(
					createExtractionSubmitTool(node, missingFields, {
						userMessage,
						...(retryNudge ? { retryNudge: true } : {}),
					}),
				),
			);
			return out;
		},

		forCapture({ node }) {
			const out: ToolDef[] = [];
			for (const t of convo.tools ?? []) out.push(adapt(t));
			for (const t of node.tools ?? []) out.push(adapt(t));
			return out;
		},
	};
}
