/**
 * @floe/runtime — public surface.
 *
 * Conversational harness on top of Flue. Class-primary (`new Assistant(...)`)
 * with subpath imports for everything else. No `floe.*` runtime namespace.
 * See docs/BLUEPRINT.md.
 */

// ─── Primary primitive ────────────────────────────────────────────────────
export { Assistant } from './assistant.ts';
export type { RunArgs, TurnHandle, TurnOutput } from './assistant.ts';

// ─── State + transcript storage (in-memory only here — durable via packages) ──
export { InMemoryAssistantStateStore } from './assistant-state-store.ts';
export type { AssistantStateStore } from './assistant-state-store.ts';
export { InMemoryTranscriptStore, makeTranscriptMessage } from './transcript-store.ts';
export type {
	TranscriptMessage,
	TranscriptSession,
	TranscriptListResult,
	TranscriptListSessionsResult,
	TranscriptStore,
} from './transcript-store.ts';

// ─── Identity helpers (constrained-type passthroughs for autocomplete) ────
export {
	defineAssistant,
	defineCaptureNode,
	defineChannel,
	defineComputeNode,
	defineExtractionNode,
	defineFlow,
	defineKnowledgeSource,
	defineProcedure,
	defineReplyNode,
	defineTool,
	defineValidator,
} from './define.ts';
export type {
	CaptureNodeInput,
	ComputeNodeInput,
	ExtractionNodeInput,
	ReplyNodeInput,
} from './define.ts';
export {
	isCaptureNode,
	isComputeNode,
	isExtractionNode,
	isReplyNode,
} from './orchestrator/node-kinds.ts';

// ─── Types ────────────────────────────────────────────────────────────────
export type {
	Action,
	ActiveFlow,
	ActiveProcedure,
	Channel,
	ChannelOverlay,
	AssistantConfig,
	AssistantInputEvent,
	AssistantMetrics,
	AssistantMode,
	AssistantOutputEvent,
	AssistantState,
	AssistantView,
	ExtractionNode,
	CaptureNode,
	ComputeNode,
	ReplyNode,
	FloeConfig,
	FloeTool,
	Flow,
	KnowledgeChunk,
	KnowledgeSource,
	Node,
	NodeContext,
	Procedure,
	ProcedureMetadata,
	ToolContext,
	ToolDef,
	ToolParameters,
	Transition,
	TurnUnderReview,
	ValidationResult,
	Validator,
	ValidatorContext,
} from './types.ts';

// ─── Memory re-exports (also available at @floe/runtime/memory) ──────────
export type {
	IngestSessionInput,
	IngestTurnInput,
	MemoryConfig,
	MemoryEntry,
	MemoryService,
	SearchMemoryRequest,
} from './memory/types.ts';

// ─── Persona ──────────────────────────────────────────────────────────────
export type { PersonaConfig } from './types.ts';
export { renderPersona } from './prompt-build.ts';

// ─── Observability re-exports (also at @floe/runtime/observability) ──────
export type {
	MetricsSink,
	ObservabilityConfig,
	TurnMetrics,
	TurnStageLatencies,
	TurnTokenUsage,
} from './observability/types.ts';

// ─── Reliability re-exports (also at @floe/runtime/reliability) ──────────
export type {
	RateLimiter,
	RateLimiterContext,
	RateLimitDecision,
} from './reliability/types.ts';

// ─── Flue surface re-exports ──────────────────────────────────────────────
// Adapter, state-store, and end-user code should depend on @floe/runtime
// only. Anything Floe consumers genuinely need from Flue (because it
// appears in a public Floe type signature) is re-exported here so they
// never have to install @flue/runtime themselves.
export type {
	FlueContext,
	FlueSession,
	Role,
	SandboxFactory,
	SessionStore,
	SessionEnv,
} from '@flue/runtime';
export { observe } from '@flue/runtime/app';
