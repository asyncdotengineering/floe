/**
 * finalize-turn — stage 4: memory ingest, state save, transcript append, metrics emit.
 *
 * Extracted from orchestrator.ts per REFACTOR-FIN-HARNESS §6 (C-7).
 */
import type { AssistantState } from '../types.ts';
import { makeTranscriptMessage } from '../transcript-store.ts';
import type { MemoryCoordinator } from '../memory/coordinator.ts';
import type { MetricsSink, ObservabilityConfig, TurnMetrics, TurnStageLatencies } from '../observability/types.ts';
import { drainRunTasks } from './task-tracker.ts';
import { drainRunCompactions } from './compaction-tracker.ts';
import type { FinalizeTurnContext } from './types.ts';

export interface FinalizeTurnResult {
	text: string;
	respondingTo: string;
	events: import('../types.ts').AssistantOutputEvent[];
	state: AssistantState;
}

export async function finalizeTurn(ctx: FinalizeTurnContext): Promise<FinalizeTurnResult> {
	const {
		session, state, events, userMessage, respondingTo,
		stages, turnStart, memory, userId, assistantText,
		totalUsageInput, totalUsageOutput, totalUsageCacheRead, totalUsageCacheWrite,
		totalUsageCost, modelsUsed, validatorVerdict, knowledgeUsage,
		memoryPreloadCount, mode, routedTo, assistantStateStore, transcriptStore,
		observability, sessionId, ctxRunId, defaultsModel, convo, isVoice,
	} = ctx;

	// Auto-ingest the turn — coordinator handles userId null-check,
	// ingest-disabled config, fire-and-forget, error swallowing.
	const ingestResult = memory.ingest({
		userId,
		userMessage,
		assistantText,
		sessionName: session.name,
		assistantName: convo.name,
		mode,
		routedTo,
	});
	stages.memoryIngestMs = ingestResult.durationMs;

	// Persist state.
	const endedAt = Date.now();
	state.metrics.lastTurnLatencyMs = endedAt - turnStart;
	await assistantStateStore.save(sessionId, state);

	// Append transcript.
	if (transcriptStore && (userMessage || assistantText)) {
		const tasks: Promise<void>[] = [];
		if (userMessage) {
			tasks.push(
				transcriptStore.append(
					sessionId,
					makeTranscriptMessage({
						role: 'user',
						text: userMessage,
						...(userId !== undefined ? { userId } : {}),
						createdAt: turnStart,
					}),
				),
			);
		}
		if (assistantText) {
			tasks.push(
				transcriptStore.append(
					sessionId,
					makeTranscriptMessage({
						role: 'assistant',
						text: assistantText,
						...(userId !== undefined ? { userId } : {}),
						createdAt: endedAt,
					}),
				),
			);
		}
		await Promise.all(tasks).catch((err) => {
			console.error(
				`[floe:transcript] append failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		});
	}

	// Emit metrics.
	stages.totalMs = endedAt - turnStart;
	emitMetrics(observability as ObservabilityConfig | undefined, {
		runId: ctxRunId,
		assistantName: convo.name,
		mode,
		routedTo: routedTo ?? null,
		flowName: state.activeFlow?.name ?? null,
		channelName: state.channelName ?? 'unknown',
		isVoice,
		userId: userId ?? null,
		startedAtMs: turnStart,
		endedAtMs: endedAt,
		stages,
		tokens: {
			input: totalUsageInput,
			output: totalUsageOutput,
			cacheRead: totalUsageCacheRead,
			cacheWrite: totalUsageCacheWrite,
			totalCostUsd: totalUsageCost,
		},
		models: modelsUsed.length ? modelsUsed : [defaultsModel ?? defaultsModel],
		producedReply: Boolean(assistantText),
		validatorVerdict,
		knowledge: knowledgeUsage,
		memoryPreloadCount,
		tasks: drainRunTasks(ctxRunId),
		interrupted: false,
		compaction: drainRunCompactions(ctxRunId),
	});

	return { text: assistantText, respondingTo, events, state };
}

function emitMetrics(
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
