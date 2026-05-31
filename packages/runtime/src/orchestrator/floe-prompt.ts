/**
 * `floePrompt(...)` — the single atomic LLM-call helper for Floe.
 *
 * Every Floe LLM invocation goes through this function. It puts Floe's
 * composed system prompt in the actual system message slot (cache-
 * friendly, no shadow tags) and dispatches the user message through
 * Flue's `session.prompt(...)` API in one operation.
 *
 * ## Why this exists
 *
 * Flue's `PromptOptions` does not surface a per-call systemPrompt
 * override. The systemPrompt is fixed at session creation time via
 * `discoverSessionContext(env)`, which composes `HEADLESS_PREAMBLE` +
 * `<cwd>/AGENTS.md` + `<cwd>/CLAUDE.md` + a directory listing. For a
 * customer-facing assistant that's wrong on three counts:
 *
 *   1. HEADLESS_PREAMBLE says "never ask questions, never wait for
 *      user input" — exactly the opposite of what a chat assistant
 *      should do.
 *   2. The disk-AGENTS.md is a stable file but Floe's per-turn prompt
 *      includes per-turn variation (knowledge chunks, memory context,
 *      active node, extraction state) that the disk file can't
 *      represent.
 *   3. The legacy workaround — wrapping Floe's composed prompt in
 *      literal `<system>…</system>` tags inside the user message body
 *      — defeats provider prompt caching (providers cache the system
 *      message + early conversation history; user messages aren't
 *      cached as a prefix). Result: every cold turn paid full price
 *      for the ~5,000-token system prompt.
 *
 * The lever: Flue's `Session.withScopedRuntime` (sandbox-BP5YFg8B.mjs
 * line 1804) rebuilds the runtime systemPrompt from
 * `this.config.systemPrompt` at the start of every `session.prompt()`
 * call. Mutating `session.config.systemPrompt` BEFORE the call
 * propagates immediately. `Session.config` isn't on Flue's public type
 * but the runtime always exposes it as a class field.
 *
 * ## What this guarantees
 *
 *   - Floe's composed prompt lands in the real system message slot.
 *     Provider prompt cache (OpenAI / Anthropic / Gemini) keys on the
 *     system prefix. `PI_CACHE_RETENTION=long` extends the TTL to 1 h.
 *   - The user message body is the user's text, verbatim. No shadow
 *     `<system>` tags, no Floe-private markup leaking to the model.
 *   - The cast is contained in ONE function. Callsites pass strings;
 *     they never touch `session.config` directly.
 *   - If the cast ever fails (Flue runtime version mismatch), we
 *     throw with a clear error. Silent degradation would hide a real
 *     bug under correct-looking behavior.
 *
 * ## Upstream fix
 *
 * Filed mentally: a Flue PR adding `PromptOptions.systemPrompt` would
 * let us delete the cast and replace this helper with a one-line
 * passthrough. Until then, the cast is the only stable lever through
 * Flue's public surface.
 */
import type * as v from 'valibot';
import type {
	FlueSession,
	PromptOptions,
	PromptResponse,
	PromptResultResponse,
} from '@flue/runtime';
import type { PiHooks } from '../types.ts';

/**
 * Arguments to {@link floePrompt}. `systemPrompt` and `userMessage`
 * are split so the callsite is explicit about what lands where on the
 * wire — no chance of accidentally wrapping system in user.
 */
export interface FloePromptArgs<S extends v.GenericSchema | undefined = undefined> {
	/** Floe-built system prompt. Lands in the actual system message slot. */
	systemPrompt: string;
	/** User's text. Lands in the user message body — raw, no markup. */
	userMessage: string;
	/** Flue session to dispatch on. */
	session: FlueSession;
	/** Per-call options forwarded to Flue's `session.prompt`. */
	options?: PromptOptions<S>;
	/**
	 * Optional Pi-layer hooks (`AssistantConfig.pi`). Applied once per
	 * session via mutation of `session.harness` fields. Composes with
	 * whatever Flue itself uses internally. See `applyPiHooks` for the
	 * composition rules.
	 */
	pi?: PiHooks;
}

/**
 * Resolved-value type of `session.prompt()` — Flue picks one based on
 * whether a `result` schema is provided. We thread the generic through
 * so structured-output callsites get typed `.data`.
 */
type FloePromptResult<S extends v.GenericSchema | undefined> = S extends v.GenericSchema
	? PromptResultResponse<v.InferOutput<S>>
	: PromptResponse;

export async function floePrompt<S extends v.GenericSchema | undefined = undefined>(
	args: FloePromptArgs<S>,
): Promise<FloePromptResult<S>> {
	applySystemPromptSlot(args.session, args.systemPrompt);
	if (args.pi) applyPiHooks(args.session, args.pi);
	// The cast to `Parameters<...>[1]` reconciles the slightly different
	// generic shapes of FloePromptArgs.options vs FlueSession.prompt's
	// own typed overload — they're structurally identical, TypeScript
	// just can't unify the conditional return without explicit help.
	return args.session.prompt(
		args.userMessage,
		args.options as Parameters<FlueSession['prompt']>[1],
	) as unknown as Promise<FloePromptResult<S>>;
}

/**
 * Direct mutation of `Session.config.systemPrompt`. Internal — only
 * `floePrompt` should call this. Throws (NOT a silent degradation) if
 * the runtime field is missing, because silent degradation would
 * route every turn through Flue's HEADLESS preamble, which is
 * actively wrong for a chat assistant.
 */
function applySystemPromptSlot(session: FlueSession, systemPrompt: string): void {
	const config = (session as unknown as { config?: { systemPrompt?: string } }).config;
	if (!config) {
		throw new Error(
			'[floe] FlueSession.config is not exposed at runtime. floePrompt() needs ' +
				'session-level systemPrompt override to bypass Flue\'s discoverSessionContext-' +
				'derived HEADLESS preamble. This indicates a Flue runtime version mismatch — ' +
				'Floe targets the Session.config field that exists in @flue/runtime@0.7.x. ' +
				'Upgrade @flue/runtime or pin to a version that exposes Session.config.systemPrompt. ' +
				'(Long-term fix: upstream PromptOptions.systemPrompt to Flue and delete this lever.)',
		);
	}
	config.systemPrompt = systemPrompt;
}

/**
 * Internal test export — exposed for unit-testing the systemPrompt slot
 * application without going through the full floePrompt path. NOT for
 * application use.
 *
 * @internal
 */
export const _internal_applySystemPromptSlot = applySystemPromptSlot;

// ─── Pi escape hatch ──────────────────────────────────────────────────────

/**
 * Marker symbol on the session indicating Pi hooks have been applied
 * once. Used to avoid re-composing the same hook on every prompt() call
 * (which would chain the wrapper N deep across N turns and eventually
 * stack-overflow on long sessions).
 */
const PI_HOOKS_APPLIED = Symbol.for('floe.pi-hooks-applied');

/**
 * Apply Pi-layer hooks to the session's underlying Pi `Agent` instance.
 * Idempotent per session: subsequent calls are no-ops, so multi-turn
 * sessions don't accumulate wrapped functions.
 *
 * Composition rules:
 *   - `onPayload`: Flue's existing handler (used internally for
 *     `configureProvider` overrides) runs FIRST, then ours. Pi sees
 *     whichever payload ours returns (or the post-Flue payload if ours
 *     returns undefined).
 *   - `onResponse`: additive — Flue's runs then ours. No return.
 *   - `sessionId`, `thinkingBudgets`: direct field assignment on the
 *     Agent state.
 *
 * Throws if `session.harness` isn't exposed (Flue runtime version
 * mismatch). Same rationale as `applySystemPromptSlot` — silent
 * degradation would hide a real bug.
 */
function applyPiHooks(session: FlueSession, pi: PiHooks): void {
	const sess = session as unknown as Record<symbol | string, unknown>;
	if (sess[PI_HOOKS_APPLIED]) return;

	const harness = sess.harness as
		| {
				onPayload?: (payload: unknown, model: unknown) => unknown | Promise<unknown>;
				onResponse?: (response: unknown, model: unknown) => void | Promise<void>;
				sessionId?: string;
				thinkingBudgets?: Record<string, unknown>;
			}
		| undefined;
	if (!harness) {
		throw new Error(
			'[floe] FlueSession.harness is not exposed at runtime. AssistantConfig.pi ' +
				'cannot apply Pi-layer hooks. Floe targets @flue/runtime@0.7.x where ' +
				'Session.harness is the Pi Agent instance. Upgrade @flue/runtime or pin ' +
				'to a version that exposes Session.harness.',
		);
	}

	if (pi.onPayload) {
		const flueOriginal = harness.onPayload;
		const userHook = pi.onPayload;
		harness.onPayload = async (payload, model) => {
			let working: unknown = payload;
			if (flueOriginal) {
				const afterFlue = await flueOriginal(working, model);
				if (afterFlue !== undefined) working = afterFlue;
			}
			const afterOurs = await userHook(working, model);
			return afterOurs ?? working;
		};
	}

	if (pi.onResponse) {
		const flueOriginal = harness.onResponse;
		const userHook = pi.onResponse;
		harness.onResponse = async (response, model) => {
			if (flueOriginal) await flueOriginal(response, model);
			await userHook(
				response as { status: number; headers: Record<string, string> },
				model,
			);
		};
	}

	if (pi.sessionId !== undefined) harness.sessionId = pi.sessionId;
	if (pi.thinkingBudgets !== undefined) harness.thinkingBudgets = pi.thinkingBudgets;

	sess[PI_HOOKS_APPLIED] = true;
}

/**
 * Internal test export. NOT for application use.
 * @internal
 */
export const _internal_applyPiHooks = applyPiHooks;
