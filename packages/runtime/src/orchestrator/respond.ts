/**
 * respond — stage 3: preLLM validators, the node-kind dispatcher, postLLM
 * validators.
 *
 * Dispatch by `Node.kind`:
 *
 *   • (no flow) host turn   — flow-entry tools, delegate, free-form text
 *   • extraction            — submit_<slug>_data tool, multi-turn partial
 *   • capture               — single-shot structured output via result schema
 *   • compute               — pure handler, no LLM, cascades silently
 *   • reply                 — fresh child session, produces text, ends turn
 *
 * Cascading: Compute → Compute is silent. Extraction.onComplete and
 * Capture.handler can return any transition; if the transition's target
 * is another Compute, the loop cascades. The moment we hit a Reply (or
 * a terminal transition with no Reply chain), the turn ends.
 */
import * as v from 'valibot';
import type { FlueHarness, FlueSession } from '@flue/runtime';
import type {
	AssistantConfig,
	AssistantMode,
	AssistantOutputEvent,
	AssistantState,
	CaptureNode,
	ExtractionNode,
	KnowledgeChunk,
	Node,
	ReplyNode,
	Transition,
} from '../types.ts';
import {
	createValidatorCoordinator,
	createValidatorResultEventSink,
} from '../validator-coordinator.ts';
import { buildSystemPrompt } from '../prompt-build.ts';
import { floePrompt } from './floe-prompt.ts';
import { reduceTransition } from './transition-reducer.ts';
import { cacheNode, getCachedNode } from '../node-cache.ts';
import {
	computeMissingFields,
	isEmptySubmission,
	mergeExtractionData,
} from './extraction.ts';
import { isComputeNode, isExtractionNode, isReplyNode } from './node-kinds.ts';
import type { TurnMetrics, TurnStageLatencies } from '../observability/types.ts';
import type { RespondOrFailure } from './types.ts';
import { MAX_TURN_NODE_DEPTH } from './index.ts';
import {
	createTurnContext,
	addUsage,
	trackModel,
	type TurnContext,
	type UsageAcc,
} from './turn-context.ts';

export interface RespondArgs {
	session: FlueSession;
	convo: AssistantConfig;
	channel: { name: string };
	state: AssistantState;
	events: AssistantOutputEvent[];
	userMessage: string;
	respondingTo: string;
	mode: AssistantMode;
	routedTo: string | undefined;
	isVoice: boolean;
	stages: TurnStageLatencies;
	knowledgeChunks: KnowledgeChunk[];
	memoryContext: string | null;
	matchedProcedures: { procedure: { path: string }; metadata: { name: string }; body: string }[];
	defaultsModel: string;
	defaults: { model: string };
	overlay: { transcriptionCorrection?: string };
	assistantStateStore: { save(sessionId: string, state: AssistantState): Promise<void> };
	sessionId: string;
	turnStart: number;
	instanceId: string;
	/** Composite abort signal (see PrepareTurnOutput.signal). */
	signal: AbortSignal;
	/**
	 * Flue harness for spawning child sessions during role delegation
	 * AND for Reply-node fresh-context calls.
	 */
	harness: FlueHarness;
	/**
	 * Pre-loaded `AGENTS.md` + `CLAUDE.md` content from `convo.configDir`,
	 * loaded once per Assistant boot (cached module-wide in
	 * `project-context.ts`). Threaded through to every `buildSystemPrompt`
	 * call so the system prompt carries the project context every turn —
	 * the agents.md pattern (Vercel evals: +47pp over tool-gated alternatives).
	 */
	projectContext: string;
}

export async function respond(args: RespondArgs): Promise<RespondOrFailure> {
	const {
		session, convo, channel, state, events, userMessage: initialUserMessage,
		respondingTo, mode, routedTo, isVoice, stages, knowledgeChunks, memoryContext,
		matchedProcedures, defaultsModel, defaults, overlay,
		assistantStateStore, sessionId, turnStart, instanceId, signal, harness,
		projectContext,
	} = args;

	let userMessage = initialUserMessage;

	// One coordinator per turn — captures the per-turn validator scope so
	// the three phase calls below don't re-pass session/state/scope args.
	const validators = createValidatorCoordinator({
		validators: convo.validators ?? [],
		session,
		state,
		assistantName: convo.name,
		flowName: state.activeFlow?.name ?? null,
		channelName: channel.name,
	});

	// preLLM phase.
	const preValidatorsStart = Date.now();
	const preResult = await validators.preLLM({ userMessage, knowledgeChunks });
	if (!('ok' in preResult.verdict) || preResult.verdict.ok !== true) {
		return {
			kind: 'failure',
			result: await finishWithValidationFailure({
				state, events, respondingTo,
				verdict: preResult.verdict,
				phase: 'preLLM',
				turnStart, assistantStateStore, sessionId,
			}),
		};
	}
	userMessage = preResult.turn.userMessage;
	stages.preLLMValidatorsMs = Date.now() - preValidatorsStart;

	// applyT runs the pure reducer + applies effects in one controlled
	// place (state mutation → events → node caching). Built before the
	// turn context so it can be passed in.
	const applyT = (t: Transition) => {
		const effect = reduceTransition(t, state, convo, respondingTo);
		if (effect.error) {
			console.error(`[floe] ${effect.error}`);
			return;
		}
		effect.stateMutation(state);
		for (const evt of effect.events) events.push(evt);
		if (effect.cacheNode) {
			cacheNode(instanceId, effect.cacheNode.flowName, effect.cacheNode.node);
		}
	};

	// Single TurnContext shared by all node-kind handlers. Owns view,
	// ctxBuilder, toolSink, registry, usage, emit, applyT, and the
	// pending-transition closure. Handlers don't re-thread these.
	const turnCtx = createTurnContext({
		session, convo, channelName: channel.name, state, events,
		respondingTo, isVoice, signal, projectContext,
		knowledgeChunks, memoryContext, matchedProcedures, overlay, defaults,
		harness, applyT,
	});
	let assistantText = '';
	let lastFinalizedTransition: Transition | null = null;

	// Dispatcher loop. Each iteration handles ONE node kind. Compute can
	// cascade silently; the LLM-calling kinds (extraction, capture, reply)
	// either advance to a follow-up node via their handler/onComplete OR
	// end the turn directly.
	for (let depth = 0; depth < MAX_TURN_NODE_DEPTH; depth++) {
		const activeNode = resolveActiveNode(convo, state, instanceId);

		// ─── (1) HOST TURN — no flow active ────────────────────────
		if (!activeNode) {
			const result = await runHostTurn({
				ctx: turnCtx, userMessage, mode, routedTo, depth, instanceId,
			});
			if (result.kind === 'flow_enter') continue;
			if (result.kind === 'reply') {
				assistantText = result.text;
				lastFinalizedTransition = result.transition;
			}
			if (result.kind === 'soft_fail') {
				assistantText = result.text;
				lastFinalizedTransition = null;
			}
			break;
		}

		// ─── (2) COMPUTE NODE — no LLM, deterministic ──────────────
		if (isComputeNode(activeNode)) {
			const transition = await Promise.resolve(activeNode.compute(turnCtx.ctxBuilder()));
			if (!transition) break;
			lastFinalizedTransition = transition;
			if (transition.kind === 'node') {
				applyT(transition);
				continue;
			}
			break;
		}

		// ─── (3) EXTRACTION NODE — multi-turn partial-submit ───────
		if (isExtractionNode(activeNode)) {
			const outcome = await runExtractionTurn({
				ctx: turnCtx, node: activeNode, userMessage,
			});
			if (outcome.kind === 'cascade') continue;
			assistantText = outcome.text;
			lastFinalizedTransition = outcome.transition;
			break;
		}

		// ─── (4) CAPTURE NODE — single-shot structured output ──────
		if (isCaptureNode(activeNode)) {
			const outcome = await runCaptureTurn({
				ctx: turnCtx, node: activeNode, userMessage,
			});
			if (outcome.kind === 'cascade') continue;
			lastFinalizedTransition = outcome.transition;
			break;
		}

		// ─── (5) REPLY NODE — parent session, forced result schema ─
		if (isReplyNode(activeNode)) {
			// Reply-specific system prompt. Reply nodes don't need
			// knowledge chunks (forced structured output, the node prompt
			// has the entire user-facing instruction) and don't need flow
			// guidance (we're inside a flow). They DO need the persona,
			// projectContext, active procedures, memory, and voice notes.
			const replySystemPrompt = buildSystemPrompt({
				assistantSystemPrompt: convo.systemPrompt,
				projectContext,
				activeNode,
				activeProcedures: matchedProcedures,
				knowledgeChunks: [],
				voice: isVoice,
				transcriptionCorrection: overlay.transcriptionCorrection ?? 'default',
				memoryContext,
				roles: convo.roles,
				citations: convo.citations,
				mode: 'direct',
				persona: convo.persona,
				flowActive: true,
			});
			const outcome = await runReplyTurn({
				ctx: turnCtx, node: activeNode, replySystemPrompt,
			});
			assistantText = outcome.text;
			lastFinalizedTransition =
				typeof activeNode.next === 'function' ? activeNode.next() : activeNode.next;
			break;
		}
	}

	// Terminal-closing fallback — runs when a terminal transition fired
	// without a Reply node providing text. Uses the parent session
	// (deliberate: the closing message gets full conversation context).
	if (
		!assistantText &&
		lastFinalizedTransition &&
		(lastFinalizedTransition.kind === 'end' ||
			lastFinalizedTransition.kind === 'escalate' ||
			lastFinalizedTransition.kind === 'handoff')
	) {
		const fallbackPrompt = buildFallbackClosingPrompt(convo, lastFinalizedTransition, state);
		try {
			const fallbackStart = Date.now();
			const fallback = await session.prompt(fallbackPrompt, { model: defaultsModel });
			turnCtx.usage.llmMs += Date.now() - fallbackStart;
			assistantText = fallback.text;
			addUsage(turnCtx.usage, fallback.usage);
		} catch (err) {
			console.error(
				`[floe] terminal-closing fallback failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	state.metrics.totalInputTokens += turnCtx.usage.input;
	state.metrics.totalOutputTokens += turnCtx.usage.output;
	state.metrics.totalCostUsd += turnCtx.usage.cost;

	// postLLM phase (sync) + postLLM-async (fire-and-observe).
	const postValidatorsStart = Date.now();
	const postTurn = { userMessage: initialUserMessage, assistantText: assistantText || undefined, knowledgeChunks };
	const validatorVerdict: TurnMetrics['validatorVerdict'] = 'ok';
	if (assistantText) {
		const postResult = await validators.postLLM(postTurn);
		if (!('ok' in postResult.verdict) || postResult.verdict.ok !== true) {
			return {
				kind: 'failure',
				result: await finishWithValidationFailure({
					state, events, respondingTo,
					verdict: postResult.verdict,
					phase: 'postLLM',
					turnStart, assistantStateStore, sessionId,
				}),
			};
		}
		// MUST use postResult.turn — the coordinator guarantees this is
		// the (possibly rewritten) turn after sync rewrites chained.
		if (postResult.turn.assistantText !== undefined) {
			assistantText = postResult.turn.assistantText;
		}
		events.push({ type: 'agent_send_text', text: assistantText, respondingTo });

		// Async phase fires-and-forgets; verdicts surface as
		// `conversation_event:validator_result` on the wire for observability.
		validators.postLLMAsync(
			{ ...postTurn, assistantText },
			createValidatorResultEventSink({ events, respondingTo }),
		);
	}

	// Apply the last transition AFTER assistantText is in.
	if (lastFinalizedTransition && assistantText) turnCtx.applyT(lastFinalizedTransition);

	stages.llmMs = turnCtx.usage.llmMs;
	stages.promptBuildMs = turnCtx.usage.promptBuildMs;
	stages.postLLMValidatorsMs = Date.now() - postValidatorsStart;

	return {
		kind: 'success',
		output: {
			assistantText,
			userMessage: initialUserMessage,
			events,
			stages,
			totalUsageInput: turnCtx.usage.input,
			totalUsageOutput: turnCtx.usage.output,
			totalUsageCacheRead: turnCtx.usage.cacheRead,
			totalUsageCacheWrite: turnCtx.usage.cacheWrite,
			totalUsageCost: turnCtx.usage.cost,
			llmTotalMs: turnCtx.usage.llmMs,
			promptBuildTotalMs: turnCtx.usage.promptBuildMs,
			lastFinalizedTransition,
			modelsUsed: turnCtx.usage.modelsUsed,
			validatorVerdict,
		},
	};
}

// ─── Predicates ───────────────────────────────────────────────────────────

function isCaptureNode(node: Node | null): node is CaptureNode {
	return !!node && node.kind === 'capture';
}

// ─── (1) HOST TURN ────────────────────────────────────────────────────────

interface HostTurnArgs {
	ctx: TurnContext;
	userMessage: string;
	mode: AssistantMode;
	routedTo: string | undefined;
	depth: number;
	instanceId: string;
}

type HostTurnResult =
	| { kind: 'flow_enter' }
	| { kind: 'reply'; text: string; transition: Transition | null }
	| { kind: 'soft_fail'; text: string };

async function runHostTurn(args: HostTurnArgs): Promise<HostTurnResult> {
	const { ctx, userMessage, mode, routedTo, depth } = args;
	const {
		session, convo, state, respondingTo, signal, projectContext,
		knowledgeChunks, memoryContext, matchedProcedures, overlay, defaults,
		harness, registry, usage, emit, applyT,
	} = ctx;
	const isVoice = ctx.isVoice;

	const toolDefs = registry.forHost({ mode, hasActiveFlow: state.activeFlow != null });

	// broadcast mode — pre-LLM fan-out (depth=0 only). Requires harness
	// (asserted because the type allows undefined, but broadcast is a
	// host-turn-only mode that only fires when a harness is wired).
	let broadcastResults: string | null = null;
	if (mode === 'broadcast' && depth === 0 && convo.roles && Object.keys(convo.roles).length > 0) {
		if (!harness) {
			throw new Error('[floe] broadcast mode requires a harness on TurnContext');
		}
		const roleNames = Object.keys(convo.roles);
		const childCalls = roleNames.map(async (roleName) => {
			const childName = `broadcast-${roleName}-${crypto.randomUUID()}`;
			const child = await harness.session(childName, { role: roleName });
			try {
				const res = await child.prompt(
					`${userMessage}\n\n(Respond directly with your specialist take. Do NOT call task() or delegate().)`,
					{ signal },
				);
				return { role: roleName, text: res.text, error: null as string | null };
			} catch (err) {
				return {
					role: roleName,
					text: '',
					error: err instanceof Error ? err.message : String(err),
				};
			}
		});
		const results = await Promise.all(childCalls);
		broadcastResults = results
			.map((r) =>
				r.error
					? `[${r.role} — error: ${r.error}]`
					: `[${r.role}] ${r.text || '(no response)'}`,
			)
			.join('\n\n');
		(state as AssistantState & { _broadcastFanout?: number })._broadcastFanout = results.length;
	}

	const promptBuildStart = Date.now();
	const systemPrompt = buildSystemPrompt({
		assistantSystemPrompt: convo.systemPrompt,
		projectContext,
		activeNode: null,
		activeProcedures: matchedProcedures,
		knowledgeChunks,
		voice: isVoice,
		transcriptionCorrection: overlay.transcriptionCorrection ?? 'default',
		memoryContext,
		roles: convo.roles,
		citations: convo.citations,
		mode,
		persona: convo.persona,
		flows: convo.flows,
		flowActive: state.activeFlow != null,
	});
	usage.promptBuildMs += Date.now() - promptBuildStart;

	const broadcastInjection = broadcastResults
		? `\n\n# Specialist responses (from broadcast mode)\n\n${broadcastResults}\n\nSynthesize these into ONE concise reply for the user.`
		: '';
	const baseOpts: {
		tools: typeof toolDefs;
		role?: string;
		model?: string;
		thinkingLevel?: AssistantConfig['thinkingLevel'];
		signal: AbortSignal;
	} = { tools: toolDefs, signal };
	if (mode === 'route' && routedTo) baseOpts.role = routedTo;
	if (convo.model) baseOpts.model = convo.model;
	if (convo.thinkingLevel) baseOpts.thinkingLevel = convo.thinkingLevel;
	trackModel(usage, baseOpts.model ?? defaults.model);

	const llmStart = Date.now();
	let stepText = '';
	try {
		const response = await floePrompt({
			session,
			systemPrompt: systemPrompt + broadcastInjection,
			userMessage: depth === 0 ? userMessage : '(Continuing the same conversation turn.)',
			options: baseOpts,
			pi: convo.pi,
		});
		usage.llmMs += Date.now() - llmStart;
		stepText = response.text;
		addUsage(usage, response.usage);
	} catch (err) {
		usage.llmMs += Date.now() - llmStart;
		return softFailFromError(err, depth, emit, respondingTo);
	}

	const pending = ctx.getPendingTransition();
	if (pending && pending.kind === 'flow_enter') {
		applyT(pending);
		ctx.clearPendingTransition();
		return { kind: 'flow_enter' };
	}

	return { kind: 'reply', text: stepText, transition: pending };
}

// ─── (3) EXTRACTION TURN ──────────────────────────────────────────────────

interface ExtractionTurnArgs {
	ctx: TurnContext;
	node: ExtractionNode;
	userMessage: string;
}

type NodeTurnResult =
	| { kind: 'cascade' }
	| { kind: 'reply'; text: string; transition: Transition | null };

async function runExtractionTurn(args: ExtractionTurnArgs): Promise<NodeTurnResult> {
	const { ctx, node, userMessage } = args;
	const {
		session, convo, state, respondingTo, signal, projectContext,
		knowledgeChunks, memoryContext, matchedProcedures, overlay, defaults,
		registry, usage, emit, applyT,
	} = ctx;
	const isVoice = ctx.isVoice;

	const missingBefore = computeMissingFields(node, state.activeFlow?.data ?? {});
	const toolDefs = registry.forExtraction({
		node, missingFields: missingBefore, userMessage,
	});

	const promptBuildStart = Date.now();
	const systemPrompt = buildSystemPrompt({
		assistantSystemPrompt: convo.systemPrompt,
		projectContext,
		activeNode: node,
		activeProcedures: matchedProcedures,
		knowledgeChunks,
		voice: isVoice,
		transcriptionCorrection: overlay.transcriptionCorrection ?? 'default',
		memoryContext,
		roles: convo.roles,
		citations: convo.citations,
		mode: 'direct',
		persona: convo.persona,
		flows: convo.flows,
		flowActive: true,
		extractionMissingFields: missingBefore,
		extractionCollectedData: state.activeFlow?.data ?? {},
	});
	usage.promptBuildMs += Date.now() - promptBuildStart;

	const baseOpts: {
		tools: typeof toolDefs;
		model?: string;
		thinkingLevel?: AssistantConfig['thinkingLevel'];
		signal: AbortSignal;
	} = { tools: toolDefs, signal };
	if (convo.model) baseOpts.model = convo.model;
	if (convo.thinkingLevel) baseOpts.thinkingLevel = convo.thinkingLevel;
	trackModel(usage, baseOpts.model ?? defaults.model);

	let stepText = '';
	const llmStart = Date.now();
	try {
		const response = await floePrompt({
			session,
			systemPrompt,
			userMessage,
			options: baseOpts,
			pi: convo.pi,
		});
		usage.llmMs += Date.now() - llmStart;
		stepText = response.text;
		addUsage(usage, response.usage);
	} catch (err) {
		usage.llmMs += Date.now() - llmStart;
		const fallback = softFailFromError(err, 0, emit, respondingTo);
		return { kind: 'reply', text: fallback.text, transition: null };
	}

	let sub = (() => {
		const p = ctx.getPendingTransition();
		return p && p.kind === 'extraction_submission'
			? (p as Extract<Transition, { kind: 'extraction_submission' }>)
			: null;
	})();

	// Retry-on-empty-submit: if the LLM called the submit tool with no
	// values AND there are still missing required fields, fire ONE more
	// LLM call with a stronger nudge that re-quotes the user message.
	// Closes the "Gemini calls submit({}) and starts a polite back-and-
	// forth for info the user already gave" failure mode.
	if (sub && isEmptySubmission(sub.args)) {
		const missingForRetry = computeMissingFields(node, state.activeFlow?.data ?? {});
		if (missingForRetry.length > 0) {
			emit({
				type: 'conversation_event',
				subtype: 'extraction_submission',
				data: {
					node: node.name,
					submitted: sub.args,
					missing: missingForRetry,
					complete: false,
					emptyRetry: true,
				},
				respondingTo,
			});
			// Rebuild the toolset with the retry-nudge variant of the
			// submit tool. The plain tool with userMessage inlined didn't
			// move the needle; the retry version explicitly says "your
			// previous call was empty, don't do that again."
			ctx.clearPendingTransition();
			const retryToolDefs = registry.forExtraction({
				node, missingFields: missingForRetry, userMessage, retryNudge: true,
			});
			const retryStart = Date.now();
			try {
				// Route through floePrompt explicitly — don't rely on the
				// previous call's mutation of session.config.systemPrompt
				// implicitly carrying forward. Same systemPrompt as the
				// original extraction call (the node's instructions
				// haven't changed); the retry-specific tooling is in
				// retryToolDefs.
				const retryResp = await floePrompt({
					session,
					systemPrompt,
					userMessage:
						`(Your previous \`submit_${slugifyName(node.name)}_data\` call had empty args. ` +
						`The user said: """${userMessage}""". Extract the fields and call the submit tool ` +
						`again now — with the actual values from that message.)`,
					options: { ...baseOpts, tools: retryToolDefs },
					pi: convo.pi,
				});
				usage.llmMs += Date.now() - retryStart;
				stepText = retryResp.text || stepText;
				addUsage(usage, retryResp.usage);
			} catch (err) {
				usage.llmMs += Date.now() - retryStart;
				// Soft-fail the retry; fall through with what we already had.
				console.error(
					`[floe:extraction] retry failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			const pAfter = ctx.getPendingTransition();
			if (pAfter && pAfter.kind === 'extraction_submission') {
				sub = pAfter as Extract<Transition, { kind: 'extraction_submission' }>;
			}
		}
	}

	if (sub) {
		if (state.activeFlow) {
			state.activeFlow.data = mergeExtractionData(
				state.activeFlow.data ?? {},
				sub.args,
			);
		}
		const missingAfter = computeMissingFields(node, state.activeFlow?.data ?? {});
		emit({
			type: 'conversation_event',
			subtype: 'extraction_submission',
			data: {
				node: node.name,
				submitted: sub.args,
				missing: missingAfter,
				complete: missingAfter.length === 0,
			},
			respondingTo,
		});
		if (missingAfter.length === 0) {
			const completionTransition = await Promise.resolve(node.onComplete(state.activeFlow?.data ?? {}, ctx.ctxBuilder()));
			if (completionTransition && completionTransition.kind === 'node') {
				applyT(completionTransition);
				return { kind: 'cascade' };
			}
			return { kind: 'reply', text: stepText, transition: completionTransition };
		}
		// Still missing — LLM should have asked conversationally. Use its
		// text reply. Turn ends.
		return { kind: 'reply', text: stepText, transition: null };
	}

	// LLM didn't call submit. Treat its text reply as the user-facing answer.
	return { kind: 'reply', text: stepText, transition: null };
}

function slugifyName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

// ─── (4) CAPTURE TURN ─────────────────────────────────────────────────────

interface CaptureTurnArgs {
	ctx: TurnContext;
	node: CaptureNode;
	userMessage: string;
}

type CaptureOutcome =
	| { kind: 'cascade' }
	| { kind: 'reply'; transition: Transition | null };

async function runCaptureTurn(args: CaptureTurnArgs): Promise<CaptureOutcome> {
	const { ctx, node, userMessage } = args;
	const {
		session, convo, state, respondingTo, signal, projectContext,
		knowledgeChunks, memoryContext, matchedProcedures, overlay, defaults,
		registry, usage, emit, applyT,
	} = ctx;
	const isVoice = ctx.isVoice;

	const toolDefs = registry.forCapture({ node });

	const promptBuildStart = Date.now();
	const systemPrompt = buildSystemPrompt({
		assistantSystemPrompt: convo.systemPrompt,
		projectContext,
		activeNode: node,
		activeProcedures: matchedProcedures,
		knowledgeChunks,
		voice: isVoice,
		transcriptionCorrection: overlay.transcriptionCorrection ?? 'default',
		memoryContext,
		roles: convo.roles,
		citations: convo.citations,
		mode: 'direct',
		persona: convo.persona,
		flows: convo.flows,
		flowActive: true,
	});
	usage.promptBuildMs += Date.now() - promptBuildStart;

	const baseOpts: {
		tools: typeof toolDefs;
		result: typeof node.schema;
		model?: string;
		thinkingLevel?: AssistantConfig['thinkingLevel'];
		signal: AbortSignal;
	} = { tools: toolDefs, result: node.schema, signal };
	if (convo.model) baseOpts.model = convo.model;
	if (convo.thinkingLevel) baseOpts.thinkingLevel = convo.thinkingLevel;
	trackModel(usage, baseOpts.model ?? defaults.model);

	let stepData: unknown = undefined;
	const llmStart = Date.now();
	try {
		const response = await floePrompt({
			session,
			systemPrompt,
			userMessage,
			options: baseOpts,
			pi: convo.pi,
		});
		usage.llmMs += Date.now() - llmStart;
		stepData = response.data;
		addUsage(usage, response.usage);
	} catch (err) {
		usage.llmMs += Date.now() - llmStart;
		const fallback = softFailFromError(err, 0, emit, respondingTo);
		return { kind: 'reply', transition: null };
		// Note: text path handled at caller via terminal fallback / dispatcher.
		// We deliberately don't return text here — capture nodes don't emit text.
		void fallback;
	}

	const pending = ctx.getPendingTransition();
	const transition = pending
		? pending
		: await Promise.resolve(node.handler(stepData as never, ctx.ctxBuilder()));
	if (transition && transition.kind === 'node') {
		applyT(transition);
		return { kind: 'cascade' };
	}
	return { kind: 'reply', transition };
}

// ─── (5) REPLY TURN ───────────────────────────────────────────────────────

interface ReplyTurnArgs {
	ctx: TurnContext;
	node: ReplyNode;
	/**
	 * Pre-built system prompt for this Reply turn. Lands in the actual
	 * system message slot via `floePrompt` — no shadow wrap, no
	 * duplicate AGENTS.md (Reply nodes previously got it once via
	 * Flue's discovered context AND once via a projectContext
	 * prepend; now it's just one copy in the system message slot like
	 * host/extraction/capture turns).
	 */
	replySystemPrompt: string;
}

/**
 * Reply turns run on the PARENT session with `tools: []` + forced
 * structured output. Earlier attempts to use a fresh child session via
 * `harness.session(...)` returned consistent empty responses on both
 * Gemini and OpenAI — likely because a freshly-spawned child session
 * has no harness-configured context and Flue's structured-output path
 * silently no-ops.
 *
 * The parent session retains conversation history (which is the trade
 * the old architecture made), but `tools: []` + the result-schema
 * forcing means the LLM CAN'T call any tool other than the internal
 * `finish`. The earlier "LLM stays silent after a tool cycle" failure
 * mode is closed because the LLM HAS to emit a `finish` call to
 * complete the structured response.
 */
async function runReplyTurn(args: ReplyTurnArgs): Promise<{ text: string }> {
	const { ctx: tctx, node, replySystemPrompt } = args;
	const { session, signal, usage, convo } = tctx;
	const pi = convo.pi;
	const nodeCtx = tctx.ctxBuilder();
	const userFacing =
		typeof node.prompt === 'function' ? node.prompt(nodeCtx) : node.prompt;
	const replySchema = v.object({ reply: v.string() });
	// User message body = the node task instructions. floePrompt routes
	// replySystemPrompt to the real system message slot atomically.
	const composed =
		`# Your task\n\nProduce the next user-facing reply. Use the \`finish\` ` +
		`tool with a non-empty \`reply\` field. Plain prose, no markdown, no ` +
		`preamble, no meta-commentary.\n\n# Instructions\n\n${userFacing}`;

	const llmStart = Date.now();
	let response = await floePrompt({
		session,
		systemPrompt: replySystemPrompt,
		userMessage: composed,
		options: { signal, result: replySchema, tools: [] },
		pi,
	});
	usage.llmMs += Date.now() - llmStart;
	addUsage(usage, response.usage);
	let text = (response.data as { reply: string } | undefined)?.reply ?? '';

	if (!text && node.retryOnEmpty !== false) {
		const nudge =
			`${composed}\n\n(Your previous \`finish\` call submitted an empty ` +
			`\`reply\`. Call \`finish\` again with the actual reply text per the ` +
			`instructions above.)`;
		const retryStart = Date.now();
		response = await floePrompt({
			session,
			systemPrompt: replySystemPrompt,
			userMessage: nudge,
			options: { signal, result: replySchema, tools: [] },
		pi,
		});
		usage.llmMs += Date.now() - retryStart;
		addUsage(usage, response.usage);
		text = (response.data as { reply: string } | undefined)?.reply ?? '';
	}
	return { text };
}

// ─── Soft-fail decoder for provider errors ───────────────────────────────

function softFailFromError(
	err: unknown,
	depth: number,
	emit: (e: AssistantOutputEvent) => void,
	respondingTo: string,
): { kind: 'soft_fail'; text: string } {
	const msg = err instanceof Error ? err.message : String(err);
	const isSoft = /MALFORMED_RESPONSE|ResultUnavailableError|prompt failed: Unhandled stop reason|429|rate.?limit|ETIMEDOUT|ECONNRESET|503/i.test(msg);
	if (!isSoft) throw err;
	console.error(`[floe:respond] provider soft-fail (depth=${depth}): ${msg}`);
	emit({
		type: 'conversation_event',
		subtype: 'validator_result',
		data: { phase: 'llm', error: msg, recovered: true },
		respondingTo,
	});
	return {
		kind: 'soft_fail',
		text: "Sorry — I hit a hiccup processing that. Could you say it again, maybe in slightly different words?",
	};
}

// ─── Active-node resolution + transition application ─────────────────────

function resolveActiveNode(
	convo: AssistantConfig,
	state: AssistantState,
	instanceId: string,
): Node | null {
	if (!state.activeFlow) return null;
	const flow = (convo.flows ?? []).find((f) => f.name === state.activeFlow!.name);
	if (!flow) return null;
	const startNode = flow.startNode();
	if (startNode.name === state.activeFlow.nodeName) return startNode;
	const cached = getCachedNode(instanceId, state.activeFlow.name, state.activeFlow.nodeName);
	if (cached) return cached;
	return startNode;
}

// `applyTransition` was deleted in the TransitionReducer refactor —
// its logic lives in pure form in `./transition-reducer.ts`. The
// orchestrator now wraps the reducer into the `applyT` closure that
// handles state mutation + event emission + node caching in one place.

function buildFallbackClosingPrompt(
	convo: AssistantConfig,
	transition: Transition,
	state: AssistantState,
): string {
	const reason =
		transition.kind === 'end'
			? transition.reason ?? 'completed'
			: transition.kind === 'escalate'
				? `escalating to ${transition.to}: ${transition.reason ?? '(no reason)'}`
				: transition.kind === 'handoff'
					? `handing off to ${transition.role}`
					: 'finished';
	const flowName = state.activeFlow?.name ?? '(no flow)';
	const flowData = state.activeFlow?.data
		? JSON.stringify(state.activeFlow.data, (_, v) => (typeof v === 'function' ? '<fn>' : v))
		: '{}';
	return `You are ${convo.name}. A multi-step flow just finished and you need to send a brief closing message to the customer.

Flow: ${flowName}
Outcome: ${reason}
Captured state (for context): ${flowData}

Write ONE warm, concise sentence (or two) confirming the outcome. Cite specific values from the captured state (refund ids, amounts, etc.) where appropriate. No filler, no "is there anything else" — just the confirmation. Plain text only.`;
}

async function finishWithValidationFailure(args: {
	state: AssistantState;
	events: AssistantOutputEvent[];
	respondingTo: string;
	verdict: import('../types.ts').ValidationResult;
	phase: 'preLLM' | 'postLLM';
	turnStart: number;
	assistantStateStore: { save(sessionId: string, state: AssistantState): Promise<void> };
	sessionId: string;
}): Promise<{ text: string; respondingTo: string; events: AssistantOutputEvent[]; state: AssistantState }> {
	const { state, events, respondingTo, verdict, phase, turnStart, assistantStateStore, sessionId } = args;
	let text = '';
	if ('rewrite' in verdict) {
		text = verdict.rewrite;
	} else if ('disambiguate' in verdict) {
		text = verdict.disambiguate;
	} else if ('escalate' in verdict) {
		text = `[Escalating to ${verdict.escalate.to ?? 'human'}: ${verdict.escalate.reason}]`;
		events.push({
			type: 'agent_escalate',
			to: verdict.escalate.to ?? 'human',
			reason: verdict.escalate.reason,
			respondingTo,
		});
	} else if ('retry' in verdict) {
		text = `[Retry requested: ${verdict.retry.hint}]`;
	}
	events.push({
		type: 'conversation_event',
		subtype: 'validator_result',
		data: { phase, verdict },
		respondingTo,
	});
	events.push({ type: 'agent_send_text', text, respondingTo });
	state.metrics.lastTurnLatencyMs = Date.now() - turnStart;
	await assistantStateStore.save(sessionId, state);
	return { text, respondingTo, events, state };
}
