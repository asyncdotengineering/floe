/**
 * @floe/inbox — conversational harness on top of @floe/runtime.
 *
 * Provides the Fin-rivaling surface: typed `Turn` records, `Conversation`
 * lifecycle, `Confidence` signal, `Handoff` policy, multi-tenant partition,
 * outcomes telemetry, and a single `defineInbox()` entrypoint emitting
 * OpenAI Chat Completions SSE as the canonical wire shape with Floe-specific
 * events riding alongside as named SSE lines.
 *
 * See REFACTOR-FIN-HARNESS.md for the full plan (v0.3).
 *
 * Current status: skeleton (C-1). Surface intentionally empty.
 */

export {} from './define-inbox.ts';
export { type Turn, type TurnOutcome, type TurnMetrics, makeTurn } from './turn.ts';
export {
	type Conversation,
	type ConversationStatus,
	transitionConversationStatus,
} from './conversation.ts';
export {
	type ConversationStore,
	type ConversationQuery,
	type TurnQuery,
	type TimeRange,
	type OutcomesRollup,
	InMemoryConversationStore,
} from './conversation-store.ts';
export {
	type ConfidenceScorer,
	CompositeConfidenceScorer,
	LlmSelfEvalScorer,
} from './confidence.ts';
export {
	type HandoffPolicy,
	type InboxPort,
	type HandoffDecision,
	type HandoffArgs,
	type HandoffResult,
	LoggingInboxAdapter,
} from './handoff.ts';
