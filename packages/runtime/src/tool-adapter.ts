/**
 * Adapter: FloeTool → Flue ToolDef.
 *
 * The hard work is yield-classification at the boundary. A FloeTool's
 * `execute` may return:
 *   - a single value (Promise<T> or T)            → tool result for the LLM
 *   - an AsyncIterable<T>                          → each yield is classified:
 *       * primitive / record                       → tool result fragment
 *       * AssistantOutputEvent                  → emitted via the channel sink
 *       * Transition                               → captured for the orchestrator
 *
 * Flue's ToolDef contract: `execute(args, signal): Promise<string>` (single
 * result string). We flatten primitive/record yields into one combined string
 * for the LLM, and route OutputEvents/Transitions to the side channels.
 */
import type { ToolDef } from '@flue/runtime';
import type {
	AssistantOutputEvent,
	FloeTool,
	ToolContext,
	ToolHooks,
	Transition,
} from './types.ts';

/** Sink the orchestrator wires up to capture out-of-band yields from tools. */
export interface ToolYieldSink {
	emitEvent(event: AssistantOutputEvent): void;
	setTransition(t: Transition): void;
}

/**
 * Build a Flue ToolDef from a FloeTool, given the per-turn context the tool
 * needs (session, conv view, sink for events/transitions, voice flag).
 */
export function adaptFloeTool(
	tool: FloeTool,
	ctxBuilder: () => ToolContext,
	sink: ToolYieldSink,
	opts: { voice: boolean; respondingTo: string; hooks?: ToolHooks },
): ToolDef {
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		async execute(args, signal): Promise<string> {
			const ctx: ToolContext = {
				...ctxBuilder(),
				signal: signal ?? new AbortController().signal,
			};

			// 1. beforeToolCall — Assistant-level cross-cutting hook.
			//    Can short-circuit (return a result without calling the tool)
			//    or mutate args. Errors are caught + logged; the tool still
			//    runs with original args. Hook NEVER fails the turn.
			let workingArgs = args;
			if (opts.hooks?.beforeToolCall) {
				try {
					const decision = await opts.hooks.beforeToolCall({
						toolName: tool.name,
						args,
						ctx,
					});
					if (decision?.shortCircuit !== undefined) {
						return stringifyForLlm(decision.shortCircuit);
					}
					if (decision?.modifiedArgs !== undefined) {
						workingArgs = decision.modifiedArgs as typeof args;
					}
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					console.warn(
						`[floe:tool-hooks] beforeToolCall threw for "${tool.name}" (${msg}); running tool with original args.`,
					);
				}
			}

			// 2. Wire the optional interim message (voice only).
			let interimTimer: NodeJS.Timeout | undefined;
			if (opts.voice && tool.interim) {
				const delay = tool.interimAfterMs ?? 800;
				interimTimer = setTimeout(() => {
					sink.emitEvent({
						type: 'agent_interim',
						text: tool.interim!,
						respondingTo: opts.respondingTo,
					});
				}, delay);
			}

			// 3. Execute the tool, capturing the result.
			let result: string;
			let executionError: unknown = undefined;
			try {
				const out = tool.execute(workingArgs, ctx);

				if (!isAsyncIterable(out)) {
					const resolved = await out;
					result = stringifyForLlm(resolved);
				} else {
					const fragments: string[] = [];
					for await (const value of out as AsyncIterable<unknown>) {
						if (isTransition(value)) {
							sink.setTransition(value);
							continue;
						}
						if (isOutputEvent(value)) {
							sink.emitEvent({
								...value,
								respondingTo: opts.respondingTo,
							} as AssistantOutputEvent);
							continue;
						}
						fragments.push(stringifyForLlm(value));
					}
					result = fragments.length === 0
						? '(tool produced no result)'
						: fragments.join('\n\n');
				}
			} catch (err) {
				executionError = err;
				result = '';
			} finally {
				if (interimTimer) clearTimeout(interimTimer);
			}

			// 4. afterToolCall — Assistant-level cross-cutting hook.
			//    Can mutate the result before the LLM sees it (PII scrub,
			//    audit log, normalization). Errors are caught + logged;
			//    the original result still flows. Hook NEVER fails the turn.
			//    Hook also sees execution errors so it can log/audit failures.
			if (opts.hooks?.afterToolCall) {
				try {
					const decision = await opts.hooks.afterToolCall({
						toolName: tool.name,
						args: workingArgs,
						ctx,
						result,
						error: executionError,
					});
					if (decision?.modifiedResult !== undefined) {
						result = stringifyForLlm(decision.modifiedResult);
						// If the hook supplied a result, consider the error
						// handled — don't re-throw.
						executionError = undefined;
					}
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					console.warn(
						`[floe:tool-hooks] afterToolCall threw for "${tool.name}" (${msg}); returning unmutated result.`,
					);
				}
			}

			// Re-throw the original execution error if the after-hook didn't
			// supply a replacement result. Preserves Flue's existing
			// tool-error handling.
			if (executionError !== undefined) throw executionError;
			return result;
		},
	};
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
	return (
		value !== null &&
		typeof value === 'object' &&
		Symbol.asyncIterator in (value as Record<symbol, unknown>)
	);
}

function isTransition(value: unknown): value is Transition {
	if (!value || typeof value !== 'object') return false;
	const k = (value as { kind?: unknown }).kind;
	return (
		k === 'node' ||
		k === 'handoff' ||
		k === 'end' ||
		k === 'escalate' ||
		k === 'stay' ||
		k === 'flow_enter' ||
		k === 'extraction_submission'
	);
}

const OUTPUT_EVENT_TYPES = new Set([
	'agent_send_text',
	'agent_send_partial',
	'agent_thinking',
	'agent_tool_called',
	'agent_tool_returned',
	'agent_interim',
	'agent_end',
	'agent_escalate',
	'sentence_boundary',
	'conversation_event',
]);

function isOutputEvent(value: unknown): value is AssistantOutputEvent {
	if (!value || typeof value !== 'object') return false;
	const t = (value as { type?: unknown }).type;
	return typeof t === 'string' && OUTPUT_EVENT_TYPES.has(t);
}

function stringifyForLlm(value: unknown): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (value === null || value === undefined) return '';
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
