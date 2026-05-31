/**
 * Public types for @floe/runtime.
 *
 * Every primitive a user writes against. Imports from @flue/runtime are kept
 * tight so the dependency surface is explicit.
 */
import type {
	FlueContext,
	FlueSession,
	ToolDef,
	ToolParameters,
} from '@flue/runtime';
import type * as v from 'valibot';

// ─── State persisted across turns ──────────────────────────────────────────

/**
 * The structured shape stored under `session.metadata.floe`. Versioned so
 * future shape changes can migrate on read.
 */
export interface AssistantState {
	readonly version: 1;
	assistantName: string;
	channelName: string;
	startedAt: string;
	turnCount: number;

	activeFlow: ActiveFlow | null;
	activeProcedures: ActiveProcedure[];

	pendingTransition: Transition | null;

	metrics: AssistantMetrics;
}

export interface ActiveFlow {
	name: string;
	nodeName: string;
	/** Per-flow state the user's node handlers can read/write via `ctx.state`. */
	data: Record<string, unknown>;
	enteredAt: string;
}

export interface ActiveProcedure {
	path: string;
	matchedAt: string;
}

export interface AssistantMetrics {
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCostUsd: number;
	lastTurnLatencyMs: number;
	interruptionCount: number;
}

// ─── Events on the wire ────────────────────────────────────────────────────

/**
 * What a Channel produces when an inbound request arrives. The orchestrator
 * consumes this.
 */
export type AssistantInputEvent =
	| {
			type: 'user_text_sent';
			content: string;
			eventId: string;
			assistantName?: string;
			metadata?: Record<string, unknown>;
	  }
	| {
			type: 'call_started';
			eventId: string;
			metadata?: Record<string, unknown>;
	  }
	| {
			type: 'user_custom_sent';
			payload: Record<string, unknown>;
			eventId: string;
	  };

/**
 * What the orchestrator emits during a turn. A Channel translates these to
 * its wire format (SSE for web, frames for Pipecat, blocks for Slack).
 */
export type AssistantOutputEvent =
	| { type: 'agent_send_text'; text: string; respondingTo: string }
	| { type: 'agent_send_partial'; delta: string; respondingTo: string }
	| { type: 'agent_thinking'; delta: string; respondingTo: string }
	| {
			type: 'agent_tool_called';
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			respondingTo: string;
	  }
	| {
			type: 'agent_tool_returned';
			toolCallId: string;
			toolName: string;
			result: unknown;
			isError: boolean;
			respondingTo: string;
	  }
	| { type: 'agent_interim'; text: string; respondingTo: string }
	| { type: 'agent_end'; reason?: string; respondingTo: string }
	| {
			type: 'agent_escalate';
			to: string;
			reason?: string;
			respondingTo: string;
	  }
	| { type: 'sentence_boundary'; respondingTo: string }
	| {
			type: 'conversation_event';
			subtype:
				| 'turn_start'
				| 'flow_enter'
				| 'flow_exit'
				| 'node_enter'
				| 'node_exit'
				| 'extraction_submission'
				| 'procedure_activated'
				| 'procedure_deactivated'
				| 'validator_result'
				| 'knowledge_query'
				| 'knowledge_hit'
				| 'memory_preloaded'
				| 'memory_ingested'
				| 'turn_interrupted';
			data: Record<string, unknown>;
			respondingTo: string;
	  };

// ─── Transitions ───────────────────────────────────────────────────────────

export type Transition =
	| { kind: 'node'; node: Node }
	| { kind: 'handoff'; role: string; reason?: string }
	| { kind: 'end'; reason?: string }
	| { kind: 'escalate'; to: string; reason?: string }
	| { kind: 'stay' }
	/**
	 * `flow_enter` — yielded by the auto-injected flow-entry tool when the
	 * LLM decides to enter a flow. Carries the flow itself + the LLM-supplied
	 * entry args (which are persisted on `state.activeFlow.data`). The
	 * orchestrator applies this transition, then continues the loop so the
	 * flow's start node executes in the same turn.
	 */
	| { kind: 'flow_enter'; flow: Flow; args?: Record<string, unknown> }
	/**
	 * `extraction_submission` — yielded by the auto-injected
	 * `submit_<node>_data` tool when the LLM submits partial extraction
	 * data. The orchestrator merges into `state.activeFlow.data`; if all
	 * required fields are now present it fires `node.extraction.onComplete`
	 * and applies the returned transition. Otherwise the LLM keeps
	 * conversing in the same extraction node (possibly across turns).
	 */
	| {
			kind: 'extraction_submission';
			node: ExtractionNode;
			args: Record<string, unknown>;
	  };

// ─── Tools ─────────────────────────────────────────────────────────────────

export interface ToolContext {
	session: FlueSession;
	conv: AssistantView;
	signal: AbortSignal;
}

/**
 * Floe's tool definition. `execute` may return a single value (treated as the
 * tool result for the LLM) or an async iterable that yields a mix of:
 *
 * - primitives/objects → tool result (concatenated for the LLM if multiple)
 * - {@link AssistantOutputEvent} → emitted to the channel
 * - {@link Transition} → applied by the orchestrator after the tool batch
 */
export interface FloeTool<P extends ToolParameters = ToolParameters> {
	name: string;
	description: string;
	parameters: P;
	/**
	 * Voice channels emit this message if `interimAfterMs` elapses before the
	 * handler returns. Other channels ignore it. Default `interimAfterMs` is 800ms.
	 */
	interim?: string;
	interimAfterMs?: number;
	execute(
		args: Record<string, unknown>,
		ctx: ToolContext,
	): AsyncIterable<unknown> | Promise<unknown> | unknown;
}

/**
 * Cross-cutting Assistant-level hooks that fire on every tool invocation.
 * Both hooks are best-effort — errors are caught + logged but never fail
 * the turn. Both hooks are async; the orchestrator awaits them in order.
 *
 * See `AssistantConfig.toolHooks` for the wiring + use-case examples.
 */
export interface ToolHooks {
	/**
	 * Fires BEFORE the tool's `execute` runs. Inspect the tool name, args,
	 * and tool context. Three possible decisions:
	 *
	 *   - return `undefined` (or omit return) → run the tool with original args.
	 *   - return `{ modifiedArgs }` → run the tool with mutated args (e.g.
	 *     inject a userId from session state, normalize an order id).
	 *   - return `{ shortCircuit }` → skip the tool entirely. The value is
	 *     stringified and returned to the LLM as the tool result. Use for
	 *     rate limiting ("Too many refund attempts this session"), cached
	 *     responses, or policy-based denial.
	 */
	beforeToolCall?: (ctx: BeforeToolCallContext) => Promise<BeforeToolCallResult | undefined> | BeforeToolCallResult | undefined;
	/**
	 * Fires AFTER the tool's `execute` returns (or throws). Inspect the
	 * result + any execution error.
	 *
	 *   - return `undefined` → result flows unchanged to the LLM (or the
	 *     error re-throws to Flue's tool-error handling).
	 *   - return `{ modifiedResult }` → swap the result. Use for PII scrub,
	 *     audit logging (log + pass through), or error recovery (replace an
	 *     exception with a graceful fallback string).
	 */
	afterToolCall?: (ctx: AfterToolCallContext) => Promise<AfterToolCallResult | undefined> | AfterToolCallResult | undefined;
}

export interface BeforeToolCallContext {
	/** The tool that's about to run. */
	toolName: string;
	/** Args the LLM emitted for this tool call. */
	args: Record<string, unknown>;
	/** The tool context (session, conv view, signal). */
	ctx: ToolContext;
}

export interface BeforeToolCallResult {
	/**
	 * Skip the tool entirely. Value is stringified and returned to the
	 * LLM as the tool result. Mutually exclusive with `modifiedArgs`.
	 */
	shortCircuit?: unknown;
	/** Mutated args passed to the tool's `execute`. */
	modifiedArgs?: Record<string, unknown>;
}

export interface AfterToolCallContext {
	toolName: string;
	args: Record<string, unknown>;
	ctx: ToolContext;
	/** Stringified tool result (what would flow to the LLM). Empty if `error`. */
	result: string;
	/** Any error the tool's `execute` threw. Undefined on success. */
	error: unknown;
}

export interface AfterToolCallResult {
	/**
	 * Replace the result string the LLM sees. If provided AND an
	 * `error` was thrown, the error is considered handled — won't
	 * re-throw to Flue.
	 */
	modifiedResult?: unknown;
}

/**
 * Pi-layer hooks surfaced on the Assistant. Applied once per session
 * via mutation of `session.harness` fields (the Pi `Agent` instance).
 * See `AssistantConfig.pi` for the surface rationale.
 */
export interface PiHooks {
	/**
	 * Mutate or replace the provider payload before HTTP send. Return
	 * `undefined` to pass through unchanged, return a new payload to swap.
	 * Composed with Flue's internal `onPayload` (used for
	 * `configureProvider` overrides) — Flue's runs first, then ours.
	 *
	 * `model` is the resolved Pi `Model` object — includes provider,
	 * api, baseUrl, contextWindow.
	 */
	onPayload?: (payload: unknown, model: unknown) => unknown | Promise<unknown>;
	/**
	 * Observe the HTTP response (status + headers) after the upstream
	 * provider responds. Side-effects only — no return value used.
	 * Useful for cost tracking from response headers, rate-limit
	 * tracking, OTel ingest. Composed additively with any existing
	 * Flue handler (both fire).
	 */
	onResponse?: (response: { status: number; headers: Record<string, string> }, model: unknown) => void | Promise<void>;
	/**
	 * Session identifier for providers that support session-based
	 * caching. Set once per Assistant; persists across turns in the
	 * same session.
	 */
	sessionId?: string;
	/**
	 * Per-provider thinking budgets — fine-grained beyond the single
	 * `thinkingLevel` field. Shape is Pi's `ThinkingBudgets` type:
	 * `{ anthropic?: number; google?: GoogleEffortLevel; openai?: ... }`.
	 * See `@earendil-works/pi-ai` `ThinkingBudgets` type for the full
	 * surface.
	 */
	thinkingBudgets?: Record<string, unknown>;
}

// ─── Nodes & Flows ────────────────────────────────────────────────────────
//
// First-principles rework (zero tech debt). A Node is a discriminated union
// of four kinds; each does ONE job. The orchestrator dispatches by `kind`.
//
//   1. ExtractionNode — multi-turn partial-submit. LLM-driven. Auto-injects
//      a `submit_<slug>_data` tool. Completes when required fields collected.
//   2. CaptureNode    — single-shot structured extraction. Forces the LLM
//      to emit `result: schema` via Flue's structured-output. Handler runs
//      deterministically on the data; returns a transition.
//   3. ComputeNode    — pure handler, NO LLM call. Reads `state`, makes a
//      decision, returns a transition. Free to cascade with other compute
//      nodes in-turn.
//   4. ReplyNode      — produces ONE user-facing text via a FRESH child
//      session (so prior tool-call history doesn't bleed in). ALWAYS ends
//      the turn. `next` is applied for the next turn's entry.
//
// Cascading: ComputeNode → ComputeNode is silent (no LLM). Extraction
// onComplete and Capture handler can return any transition; if that
// transition is `{kind:'node', node: <Compute>}`, the loop cascades into
// it. The moment a ReplyNode runs, the turn ends.

export interface NodeContext {
	session: FlueSession;
	conv: AssistantView;
	/** Per-flow mutable state — same object as `state.activeFlow.data`. */
	state: Record<string, unknown>;
}

// ── Base + per-kind shapes ────────────────────────────────────────────────

interface NodeBase {
	name: string;
	preActions?: Action[];
	postActions?: Action[];
}

/**
 * Multi-turn extraction node. The runtime auto-injects a
 * `submit_<slug>_data` tool with a nullable+optional version of
 * `schema`; the LLM submits whatever fields it has heard so far across
 * one or more turns. Merge happens on `state.activeFlow.data`.
 * `onComplete` fires once all `requiredFields` are populated.
 *
 * The LLM call uses the parent session (needs conversation history to
 * extract from earlier user messages).
 */
export interface ExtractionNode<S extends v.GenericSchema = v.GenericSchema>
	extends NodeBase {
	kind: 'extraction';
	prompt?: string;
	schema: S;
	/**
	 * Fields that must be present to fire `onComplete`. Defaults to all
	 * top-level non-optional fields on `schema`.
	 */
	requiredFields?: readonly string[];
	onComplete: (
		data: v.InferOutput<S>,
		ctx: NodeContext,
	) => Promise<Transition | null> | Transition | null;
	tools?: FloeTool[];
}

/**
 * Single-shot structured-extraction node. The LLM is forced into
 * structured-output mode via Flue's `session.prompt({result: schema})`.
 * One LLM call per turn; the handler runs deterministically with the
 * structured data and returns a transition.
 *
 * Use when the data you need is always extractable from the latest
 * user message (e.g. classifying "yes"/"no"). For multi-turn collection
 * use {@link ExtractionNode} instead.
 */
export interface CaptureNode<S extends v.GenericSchema = v.GenericSchema>
	extends NodeBase {
	kind: 'capture';
	prompt: string;
	schema: S;
	tools?: FloeTool[];
	handler: (
		data: v.InferOutput<S>,
		ctx: NodeContext,
	) => Promise<Transition | null> | Transition | null;
}

/**
 * Pure deterministic node. NO LLM call. Reads `state`, calls deterministic
 * helpers (DB lookups, math), updates `state` via the context, returns the
 * next transition.
 *
 * Compute nodes cascade silently — the orchestrator runs `compute()`, applies
 * the returned transition, and loops again. Multiple Compute nodes in a row
 * cost zero LLM tokens.
 */
export interface ComputeNode extends NodeBase {
	kind: 'compute';
	compute: (
		ctx: NodeContext,
	) => Promise<Transition | null> | Transition | null;
}

/**
 * User-facing text node. Produces ONE assistant reply per turn and ALWAYS
 * ends the turn (state advances via `next` for the following turn).
 *
 * The LLM call runs in a FRESH child session via `harness.session(...)`
 * so prior tool-call history (e.g. from an extraction tool earlier in
 * the same turn) doesn't bleed into the LLM's context. This was the
 * root cause of the "ask-confirmation returns empty text" flake in the
 * pre-rework architecture.
 *
 * `prompt` may be a static string OR a function of `NodeContext` for
 * state-templated prompts.
 */
export interface ReplyNode extends NodeBase {
	kind: 'reply';
	prompt: string | ((ctx: NodeContext) => string);
	/**
	 * Where to go after this reply is sent. Applied to `state.activeFlow`
	 * so the NEXT user turn lands at the right node.
	 *
	 * Accepts a `Transition` directly OR a thunk `() => Transition` —
	 * the thunk form is the safe pattern for forward-declared nodes
	 * (the orchestrator calls the thunk at transition time, when the
	 * referenced node is already assigned).
	 */
	next: Transition | (() => Transition);
	tools?: FloeTool[];
	/**
	 * Retry the LLM call once with a stronger nudge if the first response
	 * was empty text. Default: true.
	 */
	retryOnEmpty?: boolean;
}

/**
 * A Node is one of four explicit kinds. See `defineExtractionNode`,
 * `defineCaptureNode`, `defineComputeNode`, `defineReplyNode`.
 */
export type Node =
	| ExtractionNode
	| CaptureNode
	| ComputeNode
	| ReplyNode;

export interface Flow {
	name: string;
	/**
	 * Triage routes to this flow based on its `description`. Be specific:
	 * describe the user intent that should trigger this flow (e.g., "Multi-step
	 * refund handling, used when a customer asks to be refunded for a specific
	 * invoice"). No regex triggers — semantic LLM-based routing handles
	 * multilingual queries by default.
	 */
	description: string;
	startNode: () => Node;
}

// ─── Actions ──────────────────────────────────────────────────────────────

export type Action =
	| { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string }
	| { kind: 'say'; text: string }
	| { kind: 'emit'; event: AssistantOutputEvent }
	| { kind: 'invoke'; handler: (ctx: NodeContext) => Promise<void> | void }
	| { kind: 'audit'; event: string; data?: Record<string, unknown> };

// ─── Procedures ───────────────────────────────────────────────────────────

export interface Procedure {
	/** Path relative to the agent's sandbox cwd. Read at runtime via session.fs. */
	path: string;
	/** Optional override of frontmatter `name`. */
	name?: string;
	/** Optional override of frontmatter `triggers`. */
	triggers?: string[];
	/** Optional override of frontmatter `escalate-when`. */
	escalateWhen?: string;
	/** Populated on first activation; cached. */
	_body?: string;
	/** Populated on first activation. */
	_metadata?: ProcedureMetadata;
}

export interface ProcedureMetadata {
	name: string;
	triggers: string[];
	escalateWhen?: string;
}

// ─── Validators ────────────────────────────────────────────────────────────

export type ValidationResult =
	| { ok: true }
	| { rewrite: string }
	| { retry: { hint: string } }
	| { escalate: { reason: string; to?: string } }
	| { disambiguate: string };

export interface TurnUnderReview {
	userMessage: string;
	/** Defined for postLLM and postLLM-async; undefined for preLLM. */
	assistantText?: string;
	/** Knowledge chunks that were retrieved for this turn (if any). */
	knowledgeChunks?: import('./types.ts').KnowledgeChunk[];
}

export interface ValidatorContext {
	session: FlueSession;
	state: AssistantState;
}

export interface Validator {
	name: string;
	phase: 'preLLM' | 'postLLM' | 'postLLM-async';
	/** Default models that should run this validator. Empty = always run. */
	scope?: { agents?: string[]; flows?: string[]; channels?: string[] };
	validate(
		turn: TurnUnderReview,
		ctx: ValidatorContext,
	): Promise<ValidationResult> | ValidationResult;
}

// ─── Knowledge sources ────────────────────────────────────────────────────

export interface KnowledgeChunk {
	id: string;
	text: string;
	source: string;
	score: number;
	metadata?: Record<string, unknown>;
}

export interface KnowledgeSource {
	name: string;
	search(
		query: string,
		opts?: { limit?: number; threshold?: number },
	): Promise<KnowledgeChunk[]>;
	/**
	 * Hook for lifecycle: called once per conversation init so adapters can
	 * lazily load using the live `session.fs`. Optional.
	 */
	prepare?(session: FlueSession): Promise<void>;
}

// ─── Persona ──────────────────────────────────────────────────────────────

export interface PersonaConfig {
	/** Voice descriptor — e.g., "warm, professional", "playful and casual". */
	voice?: string;
	/** Emotional tone — e.g., "patient", "energetic", "stoic". */
	tone?: string;
	/** Register — e.g., "formal", "casual", "technical". */
	register?: string;
	/** Personal pronouns — e.g., "she/her", "they/them". */
	pronouns?: string;
	/** Phrases the agent must avoid — e.g., hollow affirmations, banned filler. */
	avoidPhrases?: string[];
	/** Signature transitions the agent prefers — e.g., "Let me think for a sec...". */
	signatureTransitions?: string[];
	/** Additional bullet-shaped guidance the renderer appends verbatim. */
	notes?: string[];
}

// ─── Channels ─────────────────────────────────────────────────────────────

/**
 * A Channel adapts inbound Flue requests into AssistantInputEvents and
 * shapes AssistantOutputEvents for the wire. Channels can also declare
 * default overlays (e.g., voice mode forces sequential tools).
 */
export interface Channel {
	name: string;
	kind: 'http' | 'process';
	/** Map a Flue request to a AssistantInputEvent. */
	parseInbound(ctx: FlueContext): Promise<AssistantInputEvent>;
	/**
	 * Map an OutputEvent to a (channel-specific) wire representation. The
	 * orchestrator does not interpret the return value — it emits as a Flue
	 * log event whose `attributes.channel_event` carries the value.
	 */
	formatOutbound?(event: AssistantOutputEvent): unknown;
	/**
	 * Defaults this channel applies on top of the conversation config.
	 * E.g., voice channels declare sequential tool execution.
	 */
	defaultOverlay?: ChannelOverlay;
	/**
	 * Optional voice-mode signal extracted from the inbound request (typically
	 * a header). Returning true switches the orchestrator into voice mode for
	 * this turn even when the channel itself is HTTP-shaped (web channel +
	 * X-Floe-Channel: voice header is the canonical case).
	 */
	isVoiceTurn?(ctx: FlueContext): boolean;
}

export interface ChannelOverlay {
	latencyBudget?: { firstTokenMs: number };
	toolExecution?: 'sequential' | 'parallel';
	sentenceBoundaryEvents?: boolean;
	interimMessages?: boolean;
	transcriptionCorrection?: 'default' | 'off' | string;
	compaction?: { reserveTokens?: number; keepRecentTokens?: number };
}

// ─── Assistant config ─────────────────────────────────────────────────────

/**
 * Coordination mode — how the runtime handles delegation between the
 * host and registered roles. See docs/BLUEPRINT.md §4.
 *
 * - `direct`     single host, no delegation. 1 LLM call/turn. Default.
 * - `route`      runtime triages to ONE role. 2 LLM calls/turn.
 * - `coordinate` host LLM delegates via the `delegate()` tool. 2+N calls.
 * - `broadcast`  fire all roles in parallel, host synthesizes. ~2 wall-clock calls.
 */
export type AssistantMode = 'direct' | 'route' | 'coordinate' | 'broadcast';

export interface AssistantConfig {
	name: string;
	/**
	 * Host system prompt. The Assistant's "brain": what it is, how it
	 * speaks, when to delegate. For single-mode (`direct`) assistants
	 * this is the whole persona. For `coordinate`/`broadcast`/`route`
	 * assistants, this is the host's persona and the roles handle
	 * specialist content.
	 */
	systemPrompt: string;
	/**
	 * Coordination mode. Defaults to `'direct'` — runtime never burns
	 * LLM cost on routing unless explicitly opted in. See AssistantMode.
	 */
	mode?: AssistantMode;
	flows?: Flow[];
	procedures?: Procedure[];
	validators?: Validator[];
	knowledge?: KnowledgeSource[];
	/**
	 * How knowledge-chunk citations should appear in the LLM's reply.
	 *
	 *   - `'required'` — the model MUST cite by bracketed number when it
	 *     uses a reference. Opt in for compliance / regulated contexts
	 *     that need a traceability paper trail (healthcare, finance, legal).
	 *   - `'optional'` — the model MAY cite when useful, omits when
	 *     citations would clutter the reply.
	 *   - `'off'` (default) — explicitly forbid bracketed citations.
	 *     Right for chat UX where "[3]" is visual noise and weaker models
	 *     are prone to hallucinating non-numeric brackets.
	 *
	 * Voice channels auto-override to `'off'` regardless of this setting.
	 * Has no effect when `knowledge` is empty.
	 */
	citations?: 'required' | 'optional' | 'off';
	/**
	 * Specialist roles available to this assistant. Floe forwards them
	 * to Flue at runtime so the LLM sees them in the system prompt
	 * registry and can delegate via `delegate({ role, prompt })`.
	 * See docs/BLUEPRINT.md §3 (Role primitive) + §4 (modes).
	 */
	roles?: Record<string, import('@flue/runtime').Role>;
	/**
	 * Tools available to every turn. Per-call tools (passed through
	 * Flow node configs) are added on top.
	 */
	tools?: FloeTool[];
	/**
	 * Optional structured persona description. Rendered as a `# Persona`
	 * Markdown block in the system prompt. Use for voice/tone/register
	 * control without rewriting the systemPrompt verbatim per environment.
	 */
	persona?: PersonaConfig;
	/** Per-call model override. Falls back to `FloeConfig.defaults.model`. */
	model?: string;
	thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
	/**
	 * Absolute path to the directory containing the config file.
	 * Procedure paths and other relative file references are resolved
	 * relative to this directory, NOT process.cwd().
	 */
	configDir?: string;
	/**
	 * Per-assistant memory overrides. If unset, inherits
	 * `FloeConfig.defaults.memory`. Pass `false` to disable memory for
	 * this assistant even when defaults have it configured.
	 */
	memory?: import('./memory/types.ts').MemoryConfig | false;
	/**
	 * Resolve the userId for memory scoping from the inbound event. Memory
	 * preload + auto-ingest only fire when this returns a non-empty string.
	 * Unset (or returning undefined) means memory is silently skipped for
	 * the turn — privacy-safe default.
	 */
	resolveUserId?: (input: AssistantInputEvent) => string | undefined;

	// ─── Deployment fields (read by adapters, e.g. webAdapter) ───────────
	/**
	 * Sandbox factory — adapters require this. See
	 * `@floe/runtime/sandbox/local|cf-bash|none`, or pass `false` to opt
	 * out. Adapters fail at construction time if neither this nor an
	 * adapter-level default is provided.
	 */
	sandbox?: import('@flue/runtime').SandboxFactory | false;
	/**
	 * Per-turn observability — pluggable metrics sinks (console / Sentry /
	 * Braintrust / OTel) receive a structured `TurnMetrics` record after
	 * every turn finishes. Non-blocking by default.
	 */
	observability?: import('./observability/types.ts').ObservabilityConfig;
	/**
	 * Compaction config. Pass `false` to disable. Defaults applied at
	 * adapter level when unset.
	 */
	compaction?:
		| false
		| {
				reserveTokens?: number;
				keepRecentTokens?: number;
				model?: string;
		  };
	/**
	 * Per-turn rate limiter. When set, the orchestrator consults the
	 * limiter BEFORE the model call. Rejected requests short-circuit
	 * with a 429-shaped failure (no LLM cost burned).
	 */
	rateLimit?: import('./reliability/types.ts').RateLimiter;
	/**
	 * State bundle. Plug in durable session/state/transcript stores
	 * (e.g. from `@floe/state-libsql`). Defaults are in-memory.
	 */
	state?: {
		sessionStore?: import('@flue/runtime').SessionStore;
		assistantStateStore?: import('./assistant-state-store.ts').AssistantStateStore;
		transcriptStore?: import('./transcript-store.ts').TranscriptStore;
	};
	/**
	 * MCP (Model Context Protocol) servers exposed to the Assistant.
	 * Floe lazy-connects on first turn and caches the connection for
	 * process lifetime.
	 */
	mcp?: import('./mcp/types.ts').McpServerConfig[];
	/**
	 * Cross-cutting tool hooks. Fire on every tool invocation, regardless
	 * of which tool. Use for:
	 *   - rate limiting (max N calls to `process_refund` per session)
	 *   - cost caps (refuse if turn cost has exceeded $X)
	 *   - audit logging (record every refund attempt)
	 *   - PII scrub on tool results before the LLM sees them
	 *   - short-circuit (return cached result without calling the tool)
	 *
	 * Lives in Floe's tool-adapter layer (NOT Pi's Agent hooks, which
	 * Flue doesn't expose). Both hooks are caught + logged — they never
	 * fail the turn. See `ToolHooks` for the per-hook contract.
	 */
	toolHooks?: ToolHooks;
	/**
	 * **Pi escape hatch — direct LLM-layer hooks.**
	 *
	 * Surface Pi (`@earendil-works/pi-ai`) hooks that Flue's `PromptOptions`
	 * doesn't expose. Mutated onto `session.harness` once per Assistant
	 * (Flue's `Session.harness` is the Pi `Agent` instance), composed
	 * with whatever Flue itself uses internally — so Flue's
	 * `configureProvider`-style overrides keep working alongside ours.
	 *
	 * Use for:
	 *   - `onPayload`: rewrite the provider request before it goes out
	 *     (inject experimental params, add headers, modify tool defs)
	 *   - `onResponse`: observe HTTP response (rate-limit headers,
	 *     cost tracking, OTel ingest)
	 *   - `sessionId`: pin caching to a specific session for providers
	 *     that key on session id (some Anthropic / Google modes)
	 *   - `thinkingBudgets`: per-provider thinking caps fine-grained
	 *     beyond the single `thinkingLevel` field
	 *
	 * NOT in this surface:
	 *   - `cacheRetention` per-call — Pi reads `PI_CACHE_RETENTION` env
	 *     var; set it at process boot (e.g. `process.env.PI_CACHE_RETENTION
	 *     ??= 'long'`).
	 *   - `steeringMode` / `followUpMode` (barge-in queues) — Pi options
	 *     not surfaced on Pi's `Agent` class as fields; requires a Flue
	 *     PR. See implementation-notes.md.
	 */
	pi?: PiHooks;
	/**
	 * **Prelude / filler — buffer-words pattern for low-perceived-latency.**
	 *
	 * Optional text emitted as the FIRST `text_delta` event on the wire
	 * (which becomes the first OpenAI `choices[0].delta.content` chunk
	 * via the canonical mux), BEFORE retrieval / memory preload / LLM
	 * call begin. From the user's perspective, response begins instantly
	 * (a few ms) — voice TTS plays "Got it — one sec…" while RAG embeds
	 * and the LLM TTFT lands ~1–2 s later, appended as the next deltas
	 * on the same stream. The user hears one continuous reply.
	 *
	 * Three forms:
	 *
	 *   prelude: 'One moment…'
	 *
	 *   prelude: (ctx) => ctx.userMessage.length > 20
	 *     ? 'Looking that up for you…'
	 *     : 'Sure — '
	 *
	 *   prelude: async (ctx) => {
	 *     // Call a FAST model for a contextual filler. p50 ~290 ms TTFT
	 *     // for gpt-4.1-mini / Groq Llama. Trades static-string instancy
	 *     // for contextual relevance — both still within voice budget.
	 *     const ack = await ctx.prompt(
	 *       `One short acknowledgement (<=8 words) of: ${ctx.userMessage}`,
	 *       { model: 'openai/gpt-4.1-mini', maxTokens: 12 },
	 *     );
	 *     return `${ack.trim()} `;
	 *   }
	 *
	 * Convention: end the filler with an ellipsis + space (`"… "`) so the
	 * real LLM tokens append with natural prosody when spoken aloud. The
	 * voice guide calls this the "buffer words" pattern.
	 *
	 * Errors in the prelude are caught and logged — they NEVER fail the
	 * turn. A broken prelude degrades to "no filler", not "no response".
	 *
	 * Default: undefined → no prelude emitted, first content delta comes
	 * from the LLM directly (legacy behavior).
	 */
	prelude?: string | ((ctx: PreludeContext) => string | Promise<string>);
}

/**
 * Context passed to a `prelude` thunk. Provides the user's message
 * verbatim plus a thin `prompt()` helper for invoking a fast model when
 * the filler needs to be contextual rather than static.
 */
export interface PreludeContext {
	/** Latest user message that triggered this turn. */
	userMessage: string;
	/** Metadata passed in on the turn (e.g. `{ userId, sessionId }`). */
	metadata: Record<string, unknown>;
	/** Channel name dispatching this turn (e.g. `'web-chat'`). */
	channel: string;
	/** Assistant name. */
	assistantName: string;
	/**
	 * Invoke any model with a one-shot text prompt. Use a fast model
	 * (gpt-4.1-mini, Groq Llama 4 Maverick) for contextual fillers;
	 * 290 ms p50 TTFT is acceptable in the voice budget if the filler
	 * is more useful than a static "one moment…".
	 *
	 * Returns the plain assistant text. The model call goes through
	 * the same Flue session that powers the main turn, so observability
	 * and cost accounting flow naturally to the same sink.
	 */
	prompt(
		prompt: string,
		opts?: { model?: string; maxTokens?: number; signal?: AbortSignal },
	): Promise<string>;
}

// ─── Floe top-level config ────────────────────────────────────────────────

export interface FloeConfig {
	assistants: Record<string, AssistantConfig>;
	channels: Record<string, Channel>;
	/**
	 * Durable storage for Floe's per-conversation auxiliary state
	 * (turnCount, activeFlow, etc.). Loaded once at turn
	 * start, saved once at turn end. Defaults to in-memory if omitted —
	 * fine for warm-only Node servers; Cloudflare DOs are inherently
	 * single-writer so the in-memory default works there too; serverless
	 * deployments (Vercel/Lambda) need a durable store like Turso.
	 */
	assistantStateStore?: import('./assistant-state-store.ts').AssistantStateStore;
	/**
	 * Durable storage for the clean, user-renderable conversation
	 * transcript (AI-SDK `UIMessage` shape). When set, three HTTP routes
	 * auto-mount: GET /history/:sessionId, GET /history/user/:userId,
	 * DELETE /history/:sessionId. Frontends (Vercel `useChat`, Cloudflare
	 * `useAgentChat`, OpenAI Conversations consumers) read history from
	 * these routes with no adapter code.
	 */
	transcriptStore?: import('./transcript-store.ts').TranscriptStore;
	defaults: {
		model: string;
		thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
		compaction?:
			| false
			| {
					reserveTokens?: number;
					keepRecentTokens?: number;
					model?: string;
			  };
		/**
		 * Sandbox factory — **required**. Floe is target-agnostic by design;
		 * we don't ship a default that imports Node-only modules (would break
		 * Cloudflare Workers / edge bundles).
		 *
		 * Pick the right factory for your target:
		 *
		 *   import { localSandbox } from '@floe/runtime/sandbox/local';
		 *   import { cfBashSandbox } from '@floe/runtime/sandbox/cf-bash';
		 *   import { noneSandbox } from '@floe/runtime/sandbox/none';
		 *
		 * - `localSandbox()` — Node: real host filesystem. Use for `tsx server.ts`
		 *   and any container/VM deploy (Render, Fly, ECS, bare Vercel Node functions).
		 * - `cfBashSandbox()` — Cloudflare Workers: just-bash + InMemoryFs. Seed
		 *   procedure/knowledge markdown via the `files` option at boot.
		 * - `noneSandbox()` — universal: in-memory, read-only files map. For tests
		 *   or agents that should be enforced fs-isolated.
		 * - `false` — opt out entirely. session.fs.* calls will throw.
		 * - Custom `SandboxFactory` — full control (e.g. wrap @cloudflare/sandbox).
		 */
		sandbox: import('@flue/runtime').SandboxFactory | false;
		/**
		 * Cross-session long-term memory. When set, the orchestrator
		 * pre-loads relevant memories into the system prompt before each
		 * LLM call and auto-ingests successful turns. Memory is only
		 * touched when the conversation has a `resolveUserId` hook AND
		 * that hook returns a non-empty string for the inbound turn.
		 */
		memory?: import('./memory/types.ts').MemoryConfig;
		/**
		 * Per-turn observability — pluggable metrics sinks (console /
		 * Sentry / Braintrust / OTel) receive a structured `TurnMetrics`
		 * record after every turn finishes. Non-blocking by default.
		 */
		observability?: import('./observability/types.ts').ObservabilityConfig;
		/**
		 * Per-turn rate limiter. When set, the orchestrator consults the
		 * limiter BEFORE triage. Rejected requests short-circuit with a
		 * 429-shaped failure (no LLM cost burned).
		 */
		rateLimit?: import('./reliability/types.ts').RateLimiter;
		/**
		 * MCP (Model Context Protocol) servers exposed to every agent.
		 * Floe lazy-connects on first turn and caches the connection for
		 * process lifetime. Servers that fail to connect are skipped (the
		 * agent runs without their tools — the conversation never dies
		 * because GitHub MCP is down). See `@floe/runtime/mcp`.
		 */
		mcp?: import('./mcp/types.ts').McpServerConfig[];
	};
}

// ─── Read-only conversation view passed to tools/validators ───────────────

export interface AssistantView {
	readonly state: Readonly<AssistantState>;
	readonly assistantName: string;
	readonly channelName: string;
	readonly isVoice: boolean;
	readonly knowledgeChunks?: KnowledgeChunk[];
}

// Re-export the Flue ToolDef shape so users importing from @floe/runtime have it.
export type { ToolDef, ToolParameters } from '@flue/runtime';
