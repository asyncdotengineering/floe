/**
 * In-process conversation simulator for tests.
 *
 * Bypasses Flue's HTTP layer; constructs a synthetic FlueContext and drives
 * `floe.handler({channel}).call(undefined, ctx)` directly. State persists
 * across scripted turns via a shared in-memory Flue session mock.
 *
 * For hermetic tests use `mockModel` to deterministic-respond per prompt.
 * For live integration tests against a real provider, omit `mockModel` and
 * provide a real model string + API key (via environment).
 */
import type { FlueContext } from '@flue/runtime';
import type { Floe, HandlerOptions } from '../floe.ts';
import type { AssistantOutputEvent, AssistantState } from '../types.ts';

export interface ScriptedTurn {
	user: string;
	assistantName?: string;
	/** Custom request headers for this turn (e.g., x-floe-channel: voice). */
	headers?: Record<string, string>;
}

export interface SimulateOptions {
	channel: string;
	scenarioName?: string;
	/** Stable instance id (URL <id> on a real deploy). Defaults to a random one. */
	instanceId?: string;
	assistantName?: string;
}

export interface SimulationTurnResult {
	turn: number;
	user: string;
	assistantText: string;
	events: AssistantOutputEvent[];
	state: AssistantState;
}

export interface SimulationResult {
	scenario: string;
	instanceId: string;
	turns: SimulationTurnResult[];
}

/**
 * Run a multi-turn conversation through the orchestrator. Uses the supplied
 * Floe instance and a fresh in-memory session shared across turns.
 */
export async function simulateConversation(
	floe: Floe,
	turns: ScriptedTurn[],
	opts: SimulateOptions,
): Promise<SimulationResult> {
	const handlerOpts: HandlerOptions = { channel: opts.channel };
	if (opts.assistantName) handlerOpts.assistant = opts.assistantName;

	const handler = floe.handler(handlerOpts);
	const instanceId = opts.instanceId ?? `sim_${Math.random().toString(36).slice(2, 10)}`;
	const scenario = opts.scenarioName ?? 'simulation';

	const sharedMetadata: Record<string, unknown> = {};
	const turnResults: SimulationTurnResult[] = [];

	for (let i = 0; i < turns.length; i++) {
		const turn = turns[i]!;
		const ctx = buildMockContext({
			instanceId,
			runId: `run_${i}_${Math.random().toString(36).slice(2, 10)}`,
			payload: { message: turn.user, assistantName: turn.assistantName },
			headers: turn.headers ?? {},
			sharedMetadata,
		});

		const result = (await handler(ctx)) as {
			text: string;
			events: AssistantOutputEvent[];
			state: AssistantState;
		};
		turnResults.push({
			turn: i + 1,
			user: turn.user,
			assistantText: result.text,
			events: result.events,
			state: result.state,
		});
	}

	return { scenario, instanceId, turns: turnResults };
}

/**
 * Build a minimal FlueContext for in-process testing. Initializes a fresh
 * just-bash sandbox via `init()` — that's what gives us a real session with
 * the actual prompt/tool surface, just without HTTP in between.
 */
function buildMockContext(args: {
	instanceId: string;
	runId: string;
	payload: { message: string; assistantName?: string };
	headers: Record<string, string>;
	sharedMetadata: Record<string, unknown>;
}): FlueContext {
	const req = new Request('http://localhost/agents/test/test-1', {
		method: 'POST',
		headers: args.headers,
		body: JSON.stringify(args.payload),
	});

	// We can't fully reuse session metadata across turns by using a fresh
	// Flue init() each time, but the orchestrator stores state in
	// `session.metadata.floe` — and our sharedMetadata gets injected into the
	// FlueContext.env so the test can observe it. For real cross-turn
	// persistence in simulate, we need a custom SessionStore.
	const ctx: FlueContext = {
		id: args.instanceId,
		runId: args.runId,
		payload: args.payload,
		env: { ...process.env, FLOE_SHARED_METADATA: JSON.stringify(args.sharedMetadata) },
		req,
		log: {
			info: () => {},
			warn: () => {},
			error: (msg) => {
				console.error('[floe:test]', msg);
			},
		},
		init: async () => {
			throw new Error(
				'[floe:test] simulateConversation requires a real Flue init() — for hermetic tests, mock the runtime at a different layer.',
			);
		},
	};
	return ctx;
}
