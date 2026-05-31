/**
 * Identity helpers for type inference. They don't do work at runtime —
 * they constrain the input type so IDE autocomplete fires inside the
 * object literal.
 *
 * Node factories follow first-principles design: one factory per Node
 * kind, each does ONE job. See `types.ts` for the four kinds and the
 * cascading rules.
 */
import type {
	AssistantConfig,
	CaptureNode,
	Channel,
	ComputeNode,
	ExtractionNode,
	FloeTool,
	Flow,
	KnowledgeSource,
	NodeContext,
	Procedure,
	ReplyNode,
	Transition,
	Validator,
} from './types.ts';
import type { ToolParameters } from '@flue/runtime';
import type * as v from 'valibot';

/** Identity helper. Use this OR `satisfies AssistantConfig` — same effect. */
export function defineAssistant(c: AssistantConfig): AssistantConfig {
	return c;
}

export function defineFlow(f: Flow): Flow {
	return f;
}

export function defineProcedure(path: string, opts?: Partial<Procedure>): Procedure {
	return { path, ...opts };
}

export function defineValidator(v: Validator): Validator {
	return v;
}

export function defineKnowledgeSource(k: KnowledgeSource): KnowledgeSource {
	return k;
}

export function defineChannel(c: Channel): Channel {
	// Freeze so users don't accidentally mutate channel objects across requests.
	return Object.freeze(c);
}

export function defineTool<P extends ToolParameters>(t: FloeTool<P>): FloeTool<P> {
	return t;
}

// ─── Node factories ──────────────────────────────────────────────────────

export interface ExtractionNodeInput<S extends v.GenericSchema> {
	name: string;
	prompt?: string;
	schema: S;
	requiredFields?: readonly (keyof v.InferOutput<S> & string)[];
	onComplete: (
		data: v.InferOutput<S>,
		ctx: NodeContext,
	) => Promise<Transition | null> | Transition | null;
	tools?: FloeTool[];
}

/**
 * Multi-turn extraction node. Runtime auto-injects `submit_<slug>_data`
 * tool; LLM submits partial data across turns; `onComplete` fires when
 * all required fields collected.
 */
export function defineExtractionNode<S extends v.GenericSchema>(
	input: ExtractionNodeInput<S>,
): ExtractionNode {
	return {
		kind: 'extraction',
		name: input.name,
		...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
		schema: input.schema,
		...(input.requiredFields !== undefined
			? { requiredFields: input.requiredFields as readonly string[] }
			: {}),
		// Cast through unknown — input handler is typed against InferOutput<S>;
		// ExtractionNode's stored handler erases the generic.
		onComplete: input.onComplete as unknown as ExtractionNode['onComplete'],
		...(input.tools !== undefined ? { tools: input.tools } : {}),
	};
}

export interface CaptureNodeInput<S extends v.GenericSchema> {
	name: string;
	prompt: string;
	schema: S;
	tools?: FloeTool[];
	handler: (
		data: v.InferOutput<S>,
		ctx: NodeContext,
	) => Promise<Transition | null> | Transition | null;
}

/**
 * Single-shot structured-extraction node. LLM is forced into
 * structured-output mode. Handler runs deterministically with the
 * structured data.
 */
export function defineCaptureNode<S extends v.GenericSchema>(
	input: CaptureNodeInput<S>,
): CaptureNode {
	return {
		kind: 'capture',
		name: input.name,
		prompt: input.prompt,
		schema: input.schema,
		...(input.tools !== undefined ? { tools: input.tools } : {}),
		handler: input.handler as unknown as CaptureNode['handler'],
	};
}

export interface ComputeNodeInput {
	name: string;
	compute: (
		ctx: NodeContext,
	) => Promise<Transition | null> | Transition | null;
}

/**
 * Pure deterministic node — no LLM call. Reads `ctx.state`, makes a
 * decision, returns a transition. Cascades silently with other compute
 * nodes for zero-token branching.
 */
export function defineComputeNode(input: ComputeNodeInput): ComputeNode {
	return {
		kind: 'compute',
		name: input.name,
		compute: input.compute,
	};
}

export interface ReplyNodeInput {
	name: string;
	prompt: string | ((ctx: NodeContext) => string);
	/**
	 * Use a thunk `() => Transition` when `next` references a
	 * forward-declared node — the thunk is invoked at transition time so
	 * the node is already assigned.
	 */
	next: Transition | (() => Transition);
	tools?: FloeTool[];
	retryOnEmpty?: boolean;
}

/**
 * User-facing text node. Runs in a FRESH child Flue session so prior
 * tool-call history doesn't bleed into context. Always ends the turn;
 * `next` advances state for the following turn.
 */
export function defineReplyNode(input: ReplyNodeInput): ReplyNode {
	return {
		kind: 'reply',
		name: input.name,
		prompt: input.prompt,
		next: input.next,
		...(input.tools !== undefined ? { tools: input.tools } : {}),
		...(input.retryOnEmpty !== undefined
			? { retryOnEmpty: input.retryOnEmpty }
			: {}),
	};
}
