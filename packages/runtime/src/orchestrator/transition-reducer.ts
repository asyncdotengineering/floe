/**
 * `reduceTransition` — pure function that turns a `Transition` into the
 * effects the orchestrator should apply to AssistantState + the events
 * to emit on the wire + any side-channel actions (node caching).
 *
 * Replaces the procedural `applyTransition` that mixed five concerns —
 * state mutation, cache mutation, event emission, validation, error
 * logging — into one 70-line switch buried in respond.ts. Now those
 * concerns are EXPLICIT in the `TransitionEffect` return value, and
 * the caller (respond.ts) applies them in one controlled place.
 *
 * The reducer is pure: same input → same output. No mutation, no I/O,
 * no console. Lets us test every transition-kind's behavior with one
 * 5-line assertion per case — without standing up a session, a config,
 * or an orchestrator.
 */
import type {
	AssistantConfig,
	AssistantOutputEvent,
	AssistantState,
	Node,
	Transition,
} from '../types.ts';

/**
 * The set of effects a transition produces. The orchestrator applies
 * each in order: `error` (if set, abort the apply), then `stateMutation`,
 * then `events`, then `cacheNode`.
 */
export interface TransitionEffect {
	/**
	 * Mutation function the caller applies to AssistantState. Kept as a
	 * function (not a state patch) because some mutations are
	 * conditional (`if (state.activeFlow) state.activeFlow.nodeName = ...`)
	 * and replicating that with a partial-state patch would lose
	 * specificity. The function is pure given the same state — testable
	 * by passing a known state and asserting the post-mutation shape.
	 */
	stateMutation: (state: AssistantState) => void;
	/**
	 * Events to emit on the wire. Order matters — caller emits them
	 * in array order after applying the state mutation. All events
	 * have `respondingTo` already populated.
	 */
	events: AssistantOutputEvent[];
	/**
	 * When set, the caller should cache this node for the active flow
	 * (via `cacheNode`). Used on `flow_enter` (cache the start node)
	 * and `node` transitions (cache the target node).
	 */
	cacheNode?: { flowName: string; node: Node };
	/**
	 * When set, the reducer detected a contract violation (e.g. handoff
	 * to a role the assistant doesn't expose). The caller should log
	 * and SKIP applying `stateMutation` + `events`. This replaces the
	 * old `console.error` + `return` pattern inside the imperative
	 * function with a value the caller decides what to do with.
	 */
	error?: string;
}

/**
 * Compute the effects a transition would produce, given the current
 * state + config. PURE. Does not mutate the state, does not emit, does
 * not log.
 */
export function reduceTransition(
	transition: Transition,
	state: AssistantState,
	convo: Pick<AssistantConfig, 'roles'>,
	respondingTo: string,
): TransitionEffect {
	switch (transition.kind) {
		case 'flow_enter': {
			const startNode = transition.flow.startNode();
			const args = transition.args ?? {};
			return {
				stateMutation: (s) => {
					s.activeFlow = {
						name: transition.flow.name,
						nodeName: startNode.name,
						data: { ...args },
						enteredAt: new Date().toISOString(),
					};
					s.pendingTransition = null;
				},
				events: [
					{
						type: 'conversation_event',
						subtype: 'flow_enter',
						data: { flow: transition.flow.name, node: startNode.name, args },
						respondingTo,
					},
				],
				cacheNode: { flowName: transition.flow.name, node: startNode },
			};
		}

		case 'node': {
			const prev = state.activeFlow?.nodeName ?? null;
			const flowName = state.activeFlow?.name;
			const cacheNodeEffect =
				flowName !== undefined ? { flowName, node: transition.node } : undefined;
			return {
				stateMutation: (s) => {
					if (s.activeFlow) s.activeFlow.nodeName = transition.node.name;
					s.pendingTransition = null;
				},
				events: [
					{
						type: 'conversation_event',
						subtype: 'node_enter',
						data: { from: prev, to: transition.node.name },
						respondingTo,
					},
				],
				...(cacheNodeEffect ? { cacheNode: cacheNodeEffect } : {}),
			};
		}

		case 'handoff': {
			if (convo.roles && !convo.roles[transition.role]) {
				return {
					stateMutation: () => {},
					events: [],
					error: `Handoff to unknown role "${transition.role}"`,
				};
			}
			return {
				stateMutation: (s) => {
					s.activeFlow = null;
					s.pendingTransition = null;
				},
				events: [
					{
						type: 'conversation_event',
						subtype: 'flow_exit',
						data: { handoffTo: transition.role, reason: transition.reason },
						respondingTo,
					},
				],
			};
		}

		case 'end':
			return {
				stateMutation: (s) => {
					s.activeFlow = null;
					s.pendingTransition = null;
				},
				events: [
					{ type: 'agent_end', reason: transition.reason, respondingTo },
				],
			};

		case 'escalate':
			return {
				stateMutation: (s) => {
					s.activeFlow = null;
					s.pendingTransition = null;
				},
				events: [
					{ type: 'agent_escalate', to: transition.to, reason: transition.reason, respondingTo },
				],
			};

		case 'stay':
			return {
				stateMutation: (s) => {
					s.pendingTransition = null;
				},
				events: [],
			};

		case 'extraction_submission':
			// Captured inline by the extraction turn handler — should not
			// reach the reducer at all. Treat as a no-op for defense in depth.
			return {
				stateMutation: (s) => {
					s.pendingTransition = null;
				},
				events: [],
			};
	}
}
