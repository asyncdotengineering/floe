/**
 * `TurnContext` — the shared per-turn invariants four turn handlers
 * used to re-thread as 17-field argument bundles.
 *
 * Before: every turn handler (`runHostTurn`, `runExtractionTurn`,
 * `runCaptureTurn`, `runReplyTurn`) duplicated the same destructuring:
 *
 *   const { session, convo, state, events, userMessage, respondingTo,
 *           isVoice, knowledgeChunks, memoryContext, matchedProcedures,
 *           defaults, overlay, signal, usage, emit, applyT,
 *           projectContext } = args;
 *
 * Each turn-args interface was a copy-paste of the others with one or
 * two node-specific fields added. Adding a new field (e.g.,
 * `projectContext`, `pi`, `toolHooks`) meant editing four arg
 * interfaces AND four destructures.
 *
 * After: one TurnContext built once at the start of `respond()`. Each
 * turn handler takes `(ctx, ...nodeSpecificArgs)`. New cross-cutting
 * fields go in one place. Argcount per handler drops from 20+ to 2-4.
 *
 * The context also OWNS the `pendingTransition` closure that
 * extraction/capture turns mutate via the `toolSink.setTransition` —
 * previously each handler had its own `let pendingTransition: ... =
 * null` which the sink wrote to via closure capture. Now it lives on
 * the context with explicit getter/clearer so handlers can read +
 * reset it without per-handler boilerplate.
 */
import type { FlueHarness, FlueSession } from '@flue/runtime';
import type {
	AssistantConfig,
	AssistantOutputEvent,
	AssistantState,
	AssistantView,
	KnowledgeChunk,
	NodeContext,
	ToolContext,
	Transition,
} from '../types.ts';
import type { ToolYieldSink } from '../tool-adapter.ts';
import { createToolRegistry, type ToolRegistry } from './tool-registry.ts';

/** Per-turn usage accumulator — shared mutable state across handlers. */
export interface UsageAcc {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	llmMs: number;
	promptBuildMs: number;
	modelsUsed: string[];
}

export function newUsageAcc(): UsageAcc {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		llmMs: 0,
		promptBuildMs: 0,
		modelsUsed: [],
	};
}

export function addUsage(
	acc: UsageAcc,
	usage:
		| {
				input?: number;
				output?: number;
				cacheRead?: number;
				cacheWrite?: number;
				cost?: { total?: number };
			}
		| undefined,
): void {
	if (!usage) return;
	acc.input += usage.input ?? 0;
	acc.output += usage.output ?? 0;
	acc.cacheRead += usage.cacheRead ?? 0;
	acc.cacheWrite += usage.cacheWrite ?? 0;
	acc.cost += usage.cost?.total ?? 0;
}

export function trackModel(acc: UsageAcc, model: string | undefined): void {
	if (model && !acc.modelsUsed.includes(model)) acc.modelsUsed.push(model);
}

/**
 * The shared per-turn context. Built once at the start of `respond()`,
 * passed to every turn handler. Owns shared invariants + accumulators
 * + the pending-transition closure.
 */
export interface TurnContext {
	// ─── Immutable invariants ─────────────────────────────────────────
	session: FlueSession;
	convo: AssistantConfig;
	channelName: string;
	state: AssistantState;
	respondingTo: string;
	isVoice: boolean;
	signal: AbortSignal;
	projectContext: string;
	knowledgeChunks: KnowledgeChunk[];
	memoryContext: string | null;
	matchedProcedures: { procedure: { path: string }; metadata: { name: string }; body: string }[];
	overlay: { transcriptionCorrection?: string };
	defaults: { model: string };
	/**
	 * Harness, when provided. Host turns use it for broadcast-mode
	 * specialist sessions and the delegate tool (coordinate mode).
	 * Extraction/capture/reply turns don't touch it.
	 */
	harness: FlueHarness | undefined;

	// ─── Shared builders / sinks ──────────────────────────────────────
	view: AssistantView;
	/** Build a NodeContext for node handlers/onComplete (session + conv + flow state). */
	ctxBuilder: () => NodeContext;
	/** Sink for tool-emitted events + transitions. */
	toolSink: ToolYieldSink;
	/** ToolRegistry — already configured with convo, ctxBuilder, sink. */
	registry: ToolRegistry;

	// ─── Shared mutable accumulators ──────────────────────────────────
	usage: UsageAcc;
	events: AssistantOutputEvent[];
	emit: (e: AssistantOutputEvent) => void;
	applyT: (t: Transition) => void;

	// ─── Pending transition (set by toolSink, read+cleared by handlers) ─
	getPendingTransition(): Transition | null;
	clearPendingTransition(): void;
}

export interface CreateTurnContextArgs {
	session: FlueSession;
	convo: AssistantConfig;
	channelName: string;
	state: AssistantState;
	events: AssistantOutputEvent[];
	respondingTo: string;
	isVoice: boolean;
	signal: AbortSignal;
	projectContext: string;
	knowledgeChunks: KnowledgeChunk[];
	memoryContext: string | null;
	matchedProcedures: { procedure: { path: string }; metadata: { name: string }; body: string }[];
	overlay: { transcriptionCorrection?: string };
	defaults: { model: string };
	/** Required only when a host turn might use `coordinate` mode. */
	harness?: FlueHarness;
	/** Closure that applies a transition (delegates to reduceTransition). */
	applyT: (t: Transition) => void;
}

export function createTurnContext(args: CreateTurnContextArgs): TurnContext {
	const view: AssistantView = {
		state: args.state,
		assistantName: args.convo.name,
		channelName: args.channelName,
		isVoice: args.isVoice,
		knowledgeChunks: args.knowledgeChunks,
	};
	const ctxBuilder = (): NodeContext => ({
		session: args.session,
		conv: view,
		state: args.state.activeFlow?.data ?? {},
	});
	// Tool adapters need a different shape (signal instead of flow state).
	// Kept private to the closure — only the registry sees it.
	const toolCtxBuilder = (): ToolContext => ({
		session: args.session,
		conv: view,
		signal: args.signal,
	});

	// Pending transition lives here so handlers don't each maintain
	// their own `let pendingTransition` + closure-captured sink.
	let pendingTransition: Transition | null = null;
	const toolSink: ToolYieldSink = {
		emitEvent: (event) => {
			args.events.push({ ...event, respondingTo: args.respondingTo });
		},
		setTransition: (t) => {
			pendingTransition = t;
		},
	};

	const registry = createToolRegistry({
		convo: args.convo,
		...(args.harness ? { harness: args.harness } : {}),
		ctxBuilder: toolCtxBuilder,
		sink: toolSink,
		isVoice: args.isVoice,
		respondingTo: args.respondingTo,
	});

	const usage = newUsageAcc();
	const emit = (e: AssistantOutputEvent) => args.events.push(e);

	return {
		session: args.session,
		convo: args.convo,
		channelName: args.channelName,
		state: args.state,
		respondingTo: args.respondingTo,
		isVoice: args.isVoice,
		signal: args.signal,
		projectContext: args.projectContext,
		knowledgeChunks: args.knowledgeChunks,
		memoryContext: args.memoryContext,
		matchedProcedures: args.matchedProcedures,
		overlay: args.overlay,
		defaults: args.defaults,
		harness: args.harness,
		view,
		ctxBuilder,
		toolSink,
		registry,
		usage,
		events: args.events,
		emit,
		applyT: args.applyT,
		getPendingTransition: () => pendingTransition,
		clearPendingTransition: () => {
			pendingTransition = null;
		},
	};
}
