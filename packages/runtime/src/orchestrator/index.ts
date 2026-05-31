/**
 * orchestrator/index.ts — 4-stage composer for runAssistantTurn.
 *
 * Stages: prepareTurn → retrieve → respond → finalizeTurn.
 * Mode-driven (direct / route / coordinate / broadcast). See
 * docs/BLUEPRINT.md §4.
 */
import type { FlueContext } from '@flue/runtime';
import type {
	Channel,
	AssistantConfig,
	AssistantOutputEvent,
	AssistantState,
	FloeConfig,
} from '../types.ts';
import {
	InMemoryAssistantStateStore,
	type AssistantStateStore,
} from '../assistant-state-store.ts';
import type { TranscriptStore } from '../transcript-store.ts';
import { formatActiveProceduresForState } from '../prompt-build.ts';
import { prepareTurn } from './prepare-turn.ts';
import { retrieve } from './retrieve.ts';
import { respond } from './respond.ts';
import { finalizeTurn } from './finalize-turn.ts';
import { beginTurn } from './turn-registry.ts';
import { emitMetrics } from './prepare-turn.ts';
import { loadProjectContext } from '../project-context.ts';

export const MAX_TURN_NODE_DEPTH = 5;

export interface RunTurnArgs {
	ctx: FlueContext;
	convo: AssistantConfig;
	channel: Channel;
	defaults: FloeConfig['defaults'];
	assistantStateStore?: AssistantStateStore;
	transcriptStore?: TranscriptStore;
}

export interface TurnResult {
	text: string;
	respondingTo: string;
	events: AssistantOutputEvent[];
	state: AssistantState;
}

const defaultAssistantStateStore = new InMemoryAssistantStateStore();

export async function runAssistantTurn(args: RunTurnArgs): Promise<TurnResult> {
	const { ctx } = args;
	const turnStartMs = Date.now();
	const turn = beginTurn(ctx.id, ctx.req?.signal);
	try {
		return await runAssistantTurnInner(args, turn.signal);
	} catch (err) {
		if (isAbortError(err)) {
			const reasonStr =
				turn.signal.reason instanceof Error
					? turn.signal.reason.message
					: String(turn.signal.reason ?? '');
			const cause: 'superseded' | 'aborted' = reasonStr.includes('Superseded')
				? 'superseded'
				: 'aborted';
			return handleInterruption({ ...args, turnStartMs, cause, reason: err });
		}
		throw err;
	} finally {
		turn.release();
	}
}

function isAbortError(err: unknown): boolean {
	if (err instanceof Error) {
		if (err.name === 'AbortError') return true;
		if ('code' in err && (err as { code?: string }).code === 'ABORT_ERR') return true;
	}
	return false;
}

interface HandleInterruptionArgs extends RunTurnArgs {
	turnStartMs: number;
	cause: 'superseded' | 'aborted';
	reason: unknown;
}

function handleInterruption(args: HandleInterruptionArgs): TurnResult {
	const { ctx, convo, channel, defaults, turnStartMs, cause, reason } = args;
	const endedAtMs = Date.now();
	const event: AssistantOutputEvent = {
		type: 'conversation_event',
		subtype: 'turn_interrupted',
		data: {
			reason: cause,
			message: reason instanceof Error ? reason.message : String(reason),
		},
		respondingTo: 'turn-interrupted',
	};
	const zeroStages = {
		triageMs: 0,
		knowledgeMs: 0,
		memoryPreloadMs: 0,
		preLLMValidatorsMs: 0,
		promptBuildMs: 0,
		llmMs: 0,
		postLLMValidatorsMs: 0,
		memoryIngestMs: 0,
		totalMs: endedAtMs - turnStartMs,
	};
	emitMetrics(defaults.observability, {
		runId: ctx.runId,
		assistantName: convo.name,
		mode: convo.mode ?? 'direct',
		flowName: null,
		channelName: channel.name,
		isVoice:
			(typeof channel.isVoiceTurn === 'function' && channel.isVoiceTurn(ctx)) ||
			channel.kind === 'process',
		userId: null,
		startedAtMs: turnStartMs,
		endedAtMs,
		stages: zeroStages,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalCostUsd: 0 },
		models: [],
		producedReply: false,
		validatorVerdict: 'block',
		knowledge: [],
		memoryPreloadCount: 0,
		tasks: { count: 0, totalMs: 0, errors: 0 },
		interrupted: true,
		compaction: { count: 0, totalMs: 0, messagesDropped: 0 },
	});
	return {
		text: '',
		respondingTo: 'turn-interrupted',
		events: [event],
		state: {
			version: 1,
			assistantName: convo.name,
			channelName: channel.name,
			startedAt: new Date(turnStartMs).toISOString(),
			turnCount: 0,
			activeFlow: null,
			activeProcedures: [],
			pendingTransition: null,
			metrics: {
				totalInputTokens: 0,
				totalOutputTokens: 0,
				totalCostUsd: 0,
				lastTurnLatencyMs: endedAtMs - turnStartMs,
				interruptionCount: 1,
			},
		},
	};
}

async function runAssistantTurnInner(
	args: RunTurnArgs,
	signal: AbortSignal,
): Promise<TurnResult> {
	const { ctx, convo, channel, defaults } = args;
	const assistantStateStore = args.assistantStateStore ?? defaultAssistantStateStore;
	const transcriptStore = args.transcriptStore;

	// Stage 1: prepare (parse input, load state, mode resolution).
	const prepared = await prepareTurn({
		ctx,
		convo,
		channel,
		defaults,
		assistantStateStore,
		signal,
	});
	if (prepared.kind === 'exit') return prepared.result;
	const p = prepared.output;

	// Stage 1.5: prelude (fire-and-forget so retrieve runs in parallel).
	// The prelude resolves to a string — emitted as a synthetic
	// `text_delta` event the moment it's ready. The canonical mux
	// translates it into the wire's FIRST OpenAI `content` delta, so the
	// user perceives <100 ms TTFT (for a static string) or ~290 ms (for
	// a fast-model-backed thunk). We `await` the promise before stage 3
	// kicks off the real LLM call to guarantee wire ordering — prelude
	// always lands before LLM tokens. See `prelude` on AssistantConfig.
	const preludePromise = invokePrelude({
		convo,
		ctx,
		userMessage: p.userMessage,
		metadata: extractMetadata(ctx),
		channelName: channel.name,
		session: p.session,
		signal: p.signal,
	});

	// Stage 2: retrieve (procedures, knowledge, memory).
	const retrieved = await retrieve({
		session: p.session,
		convo,
		userMessage: p.userMessage,
		events: p.events,
		respondingTo: p.respondingTo,
		memory: p.memory,
		userId: p.userId,
		stages: p.stages,
	});
	p.state.activeProcedures = formatActiveProceduresForState(
		retrieved.matchedProcedures.map((m) => ({
			procedure: m.procedure,
			metadata: m.metadata,
			body: m.body,
		})),
	);

	// Stage 3: respond (validators + LLM loop).
	// Project context (AGENTS.md + CLAUDE.md from configDir) — loaded
	// once per Assistant boot (module-cached in `project-context.ts`),
	// retrieved here on every turn for ~microseconds. Threaded into every
	// `buildSystemPrompt` site + Reply node's composed prompt so the
	// agents.md content lands on every turn's system prompt.
	const projectContext = await loadProjectContext(convo.configDir);

	// Make sure the prelude landed on the wire BEFORE LLM tokens start
	// streaming. If the prelude is slow (LLM-backed thunk that took
	// longer than retrieve), this is where we pay; if it's a static
	// string or fast model, this is already resolved.
	await preludePromise;

	const resp = await respond({
		session: p.session,
		convo,
		channel,
		state: p.state,
		events: retrieved.events,
		userMessage: p.userMessage,
		respondingTo: p.respondingTo,
		mode: p.mode,
		routedTo: p.routedTo,
		isVoice: p.isVoice,
		stages: retrieved.stages,
		knowledgeChunks: retrieved.knowledgeChunks,
		memoryContext: retrieved.memoryContext,
		matchedProcedures: retrieved.matchedProcedures,
		defaultsModel: defaults.model,
		defaults,
		overlay: p.overlay as { transcriptionCorrection?: string },
		assistantStateStore,
		sessionId: ctx.id,
		turnStart: p.turnStart,
		instanceId: ctx.id,
		signal: p.signal,
		harness: p.harness,
		projectContext,
	});
	if (resp.kind === 'failure') return resp.result;
	const r = resp.output;

	// Stage 4: finalize (memory ingest, persist state, transcript, metrics).
	const finalCtx = {
		session: p.session,
		convo: { name: convo.name, systemPrompt: convo.systemPrompt, flows: convo.flows },
		state: p.state,
		events: r.events,
		userMessage: r.userMessage,
		respondingTo: p.respondingTo,
		mode: p.mode,
		routedTo: p.routedTo,
		isVoice: p.isVoice,
		userId: p.userId,
		stages: r.stages,
		turnStart: p.turnStart,
		memory: p.memory,
		assistantText: r.assistantText,
		lastFinalizedTransition: r.lastFinalizedTransition,
		totalUsageInput: r.totalUsageInput,
		totalUsageOutput: r.totalUsageOutput,
		totalUsageCacheRead: r.totalUsageCacheRead,
		totalUsageCacheWrite: r.totalUsageCacheWrite,
		totalUsageCost: r.totalUsageCost,
		modelsUsed: r.modelsUsed,
		validatorVerdict: r.validatorVerdict,
		knowledgeUsage: retrieved.knowledgeUsage,
		memoryPreloadCount: retrieved.memoryPreloadCount,
		assistantStateStore,
		transcriptStore: transcriptStore as _FTC['transcriptStore'],
		observability: defaults.observability,
		sessionId: ctx.id,
		ctxRunId: ctx.runId,
		defaultsModel: defaults.model,
		defaults,
		view: {} as never,
	};
	return finalizeTurn(finalCtx);
}

// Re-export types for consumers
export type {
	PrepareTurnOutput,
	RetrieveOutput,
	RespondOutput,
	FinalizeTurnContext,
} from './types.ts';

// Needed for the finalize-turn type annotation
import type { FinalizeTurnContext as _FTC } from './types.ts';

// ─── Prelude (buffer-words) helper ──────────────────────────────────────────

import type { FlueSession } from '@flue/runtime';
import type { PreludeContext } from '../types.ts';

interface InvokePreludeArgs {
	convo: AssistantConfig;
	ctx: FlueContext;
	userMessage: string;
	metadata: Record<string, unknown> | undefined;
	channelName: string;
	session: FlueSession;
	signal: AbortSignal;
}

/**
 * Resolve the assistant's `prelude` (string or thunk) and emit it as a
 * synthetic `text_delta` event on Flue's wire. Designed for fire-and-
 * forget: caller invokes without awaiting, runs `retrieve` in parallel,
 * then awaits this promise before letting the main LLM start streaming.
 *
 * Errors are caught and logged — a broken prelude NEVER fails the turn.
 * Worst case the user just doesn't hear the filler; the real reply still
 * lands normally.
 */
function extractMetadata(ctx: FlueContext): Record<string, unknown> {
	const payload = ctx.payload as { metadata?: Record<string, unknown> } | undefined;
	return payload?.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
}

async function invokePrelude(args: InvokePreludeArgs): Promise<void> {
	const { convo, ctx, userMessage, metadata, channelName, session, signal } = args;
	if (!convo.prelude) return;
	try {
		let text: string;
		if (typeof convo.prelude === 'string') {
			text = convo.prelude;
		} else {
			const preludeCtx: PreludeContext = {
				userMessage,
				metadata: metadata ?? {},
				channel: channelName,
				assistantName: convo.name,
				prompt: async (prompt, opts) => {
					// One-shot text completion via the parent session, so cost
					// and observability flow to the same sink as the main turn.
					// No tools, no result schema — plain text out.
					const response = await session.prompt(prompt, {
						signal: opts?.signal ?? signal,
						tools: [],
						...(opts?.model ? { model: opts.model } : {}),
						...(opts?.maxTokens !== undefined
							? { maxResponseTokens: opts.maxTokens }
							: {}),
					} as Parameters<FlueSession['prompt']>[1]);
					return (response.text ?? '').trim();
				},
			};
			text = await convo.prelude(preludeCtx);
		}
		if (typeof text === 'string' && text.length > 0) {
			// `ctx` is a FlueContextInternal at runtime — Flue's handler
			// signature is `(ctx: FlueContextInternal) => ...`, but the
			// public type narrows to FlueContext. Cast to reach emitEvent,
			// which dispatches synthetic events onto the SSE wire (the
			// same channel Pi's per-token deltas come through).
			(ctx as unknown as { emitEvent: (e: { type: string; text: string }) => void }).emitEvent({
				type: 'text_delta',
				text,
			});
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// Best-effort warning. The turn continues without a prelude.
		console.warn(`[floe:prelude] prelude failed (${msg}); continuing without filler.`);
	}
}
