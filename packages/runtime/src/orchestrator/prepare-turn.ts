/**
 * prepare-turn — stage 1: input parsing, state load, mode resolution.
 *
 * Replaces the old triage/agent-routing subsystem with mode-driven
 * dispatch:
 *   - 'direct'      → host runs alone
 *   - 'route'       → runtime triages to ONE role (cheap LLM call)
 *   - 'coordinate'  → host LLM delegates via `delegate` tool
 *   - 'broadcast'   → respond stage fans out to all roles in parallel
 *
 * See docs/BLUEPRINT.md §4.
 */
import type { AgentInit, FlueContext } from '@flue/runtime';
import type {
	Channel,
	AssistantConfig,
	AssistantMode,
	AssistantOutputEvent,
	AssistantState,
	FloeConfig,
} from '../types.ts';
import { freshState } from '../state.ts';
import {
	InMemoryAssistantStateStore,
	type AssistantStateStore,
} from '../assistant-state-store.ts';
import { runRouteSelection } from './route-mode.ts';
import { getMcpTools } from '../mcp/registry.ts';
import type { MemoryConfig } from '../memory/types.ts';
import { createMemoryCoordinator } from '../memory/coordinator.ts';
import type {
	MetricsSink,
	ObservabilityConfig,
	TurnMetrics,
	TurnStageLatencies,
} from '../observability/types.ts';
import type { PrepareTurnOutput } from './types.ts';

export interface PrepareTurnArgs {
	ctx: FlueContext;
	convo: AssistantConfig;
	channel: Channel;
	defaults: FloeConfig['defaults'];
	assistantStateStore?: AssistantStateStore;
	/**
	 * Composite abort signal owned by runAssistantTurn (see
	 * orchestrator/turn-registry.ts). Tests may omit; orchestrator
	 * always supplies one.
	 */
	signal?: AbortSignal;
	/**
	 * Per-call mode override. Beats the assistant-level default.
	 * Adapters use this to force mode='direct' on voice channels.
	 */
	modeOverride?: AssistantMode;
}

const defaultAssistantStateStore = new InMemoryAssistantStateStore();

/**
 * Result from prepareTurn. Returns either a full TurnResult (on early
 * exit — rate limit block) or the stage output for continued processing.
 */
export type PrepareTurnResult =
	| { kind: 'exit'; result: { text: string; respondingTo: string; events: AssistantOutputEvent[]; state: AssistantState } }
	| { kind: 'continue'; output: PrepareTurnOutput };

export function emitMetrics(
	observability: ObservabilityConfig | undefined,
	metrics: TurnMetrics,
): void {
	if (!observability?.sinks || observability.sinks.length === 0) return;
	if (observability.sampleRate !== undefined && observability.sampleRate < 1) {
		if (Math.random() > observability.sampleRate) return;
	}
	const fire = (sink: MetricsSink): void => {
		try {
			const result = sink.record(metrics);
			if (result && typeof (result as Promise<void>).catch === 'function') {
				(result as Promise<void>).catch((err) => {
					console.error(
						`[floe:metrics] sink ${sink.name} failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				});
			}
		} catch (err) {
			console.error(
				`[floe:metrics] sink ${sink.name} threw: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	};
	if (observability.awaitSinks) {
		(async () => {
			for (const s of observability.sinks!) {
				try {
					await Promise.resolve(s.record(metrics));
				} catch (err) {
					console.error(
						`[floe:metrics] sink ${s.name} threw: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
		})();
		return;
	}
	for (const s of observability.sinks) fire(s);
}

export async function prepareTurn(args: PrepareTurnArgs): Promise<PrepareTurnResult> {
	const { ctx, convo, channel, defaults } = args;
	const assistantStateStore = args.assistantStateStore ?? defaultAssistantStateStore;
	const sessionId = ctx.id;
	const turnStart = Date.now();

	const stages: TurnStageLatencies = {
		triageMs: 0,
		knowledgeMs: 0,
		memoryPreloadMs: 0,
		preLLMValidatorsMs: 0,
		promptBuildMs: 0,
		llmMs: 0,
		postLLMValidatorsMs: 0,
		memoryIngestMs: 0,
		totalMs: 0,
	};

	// 1. Channel parses inbound.
	const input = await channel.parseInbound(ctx);
	const respondingTo = input.type === 'user_text_sent' ? input.eventId : input.eventId;
	const userMessage = input.type === 'user_text_sent' ? input.content : '';

	// 1b. Rate limiting.
	if (defaults.rateLimit) {
		const decision = await Promise.resolve(
			defaults.rateLimit.check({
				conversation: convo.name,
				userId: convo.resolveUserId ? convo.resolveUserId(input) : undefined,
				input,
				channelName: channel.name,
			}),
		);
		if (!decision.allow) {
			const blockEvents: AssistantOutputEvent[] = [
				{
					type: 'conversation_event',
					subtype: 'validator_result',
					data: {
						validator: defaults.rateLimit.name,
						phase: 'rate-limit',
						result: { reason: decision.reason, retryAfterSeconds: decision.retryAfterSeconds },
					},
					respondingTo,
				},
			];
			emitMetrics(defaults.observability, {
				runId: ctx.runId,
				assistantName: convo.name,
				mode: 'direct',
				flowName: null,
				channelName: channel.name,
				isVoice:
					(typeof channel.isVoiceTurn === 'function' && channel.isVoiceTurn(ctx)) ||
					channel.kind === 'process',
				userId: convo.resolveUserId?.(input) ?? null,
				startedAtMs: turnStart,
				endedAtMs: Date.now(),
				stages: { ...stages, totalMs: Date.now() - turnStart },
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalCostUsd: 0 },
				models: [],
				producedReply: false,
				validatorVerdict: 'block',
				knowledge: [],
				memoryPreloadCount: 0,
				tasks: { count: 0, totalMs: 0, errors: 0 },
				interrupted: false,
				compaction: { count: 0, totalMs: 0, messagesDropped: 0 },
			});
			const stateFallback =
				(await assistantStateStore.load(sessionId)) ??
				freshState({ assistantName: convo.name, channelName: channel.name });
			return {
				kind: 'exit',
				result: {
					text: decision.reason ?? 'Rate limit exceeded.',
					respondingTo,
					events: blockEvents,
					state: stateFallback,
				},
			};
		}
	}

	// Voice mode.
	const isVoice =
		(typeof channel.isVoiceTurn === 'function' && channel.isVoiceTurn(ctx)) ||
		channel.kind === 'process';

	// 2. Init Flue harness.
	const overlay = channel.defaultOverlay ?? {};
	const sandboxConfig = defaults.sandbox;
	const initOptions: AgentInit = {
		model: convo.model ?? defaults.model,
		thinkingLevel: convo.thinkingLevel ?? defaults.thinkingLevel,
		compaction: overlay.compaction ?? defaults.compaction,
	};
	// Plumb the workspace root through Flue's canonical init({cwd}) API.
	// See repo/flue/packages/runtime/src/client.ts:113-144.
	if (convo.configDir) {
		initOptions.cwd = convo.configDir;
	}
	// Pattern C: sandbox is REQUIRED on FloeConfig.defaults — no surprise
	// Node imports in the runtime core.
	initOptions.sandbox = sandboxConfig;
	// MCP tools: lazy-connect on first turn, cached for process lifetime.
	if (defaults.mcp && defaults.mcp.length > 0) {
		const mcpTools = await getMcpTools(defaults.mcp);
		if (mcpTools.length > 0) initOptions.tools = mcpTools;
	}
	const harness = await ctx.init(initOptions);
	const session = await harness.session();

	// 3. Read or freshen state.
	const state =
		(await assistantStateStore.load(sessionId)) ??
		freshState({ assistantName: convo.name, channelName: channel.name });
	state.turnCount += 1;

	const events: AssistantOutputEvent[] = [];
	const emit = (e: AssistantOutputEvent) => events.push(e);

	emit({
		type: 'conversation_event',
		subtype: 'turn_start',
		data: { turnCount: state.turnCount, channelName: channel.name, isVoice },
		respondingTo,
	});

	// 4. Resolve coordination mode.
	const mode: AssistantMode = args.modeOverride ?? convo.mode ?? 'direct';

	// 5. Mode-specific pre-LLM work (route mode picks a role via cheap call).
	const routeStart = Date.now();
	let routedTo: string | undefined;
	if (mode === 'route' && convo.roles && Object.keys(convo.roles).length > 0) {
		try {
			routedTo = await runRouteSelection({
				session,
				roles: convo.roles,
				userMessage,
				model: convo.model ?? defaults.model,
			});
		} catch (err) {
			console.error(
				`[floe:route] selection failed, falling back to first role: ${err instanceof Error ? err.message : String(err)}`,
			);
			routedTo = Object.keys(convo.roles)[0];
		}
	}
	stages.triageMs = Date.now() - routeStart;

	// Resolve memory config → coordinator. Coordinator is a no-op stub
	// when memory isn't configured, so no null-checks downstream.
	const memoryCfg = resolveMemoryConfig(convo, defaults);
	const memory = createMemoryCoordinator(memoryCfg);
	const userId = memoryCfg && convo.resolveUserId ? convo.resolveUserId(input) : undefined;

	return {
		kind: 'continue',
		output: {
			session,
			harness,
			state,
			events,
			userMessage,
			respondingTo,
			mode,
			routedTo,
			isVoice,
			userId,
			stages,
			turnStart,
			memory,
			overlay,
			signal: args.signal ?? new AbortController().signal,
		},
	};
}

function resolveMemoryConfig(
	convo: AssistantConfig,
	defaults: FloeConfig['defaults'],
): MemoryConfig | null {
	if (convo.memory === false) return null;
	if (convo.memory) return convo.memory;
	return defaults.memory ?? null;
}
