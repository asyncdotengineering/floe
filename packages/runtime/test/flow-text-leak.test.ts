/**
 * Regression test for the flow-text-leak bug.
 *
 * The bug (observed in campus-bot's add-drop flow with gpt-4.1-mini):
 * when the host LLM emits both filler text AND a flow-entry tool call
 * in the same turn, the filler text streams to the user as text_delta
 * events, the flow runs and produces its own Reply node text, and the
 * user sees BOTH concatenated:
 *
 *   "I'll check the term week... Drop of CS 351 confirmed — proceed."
 *
 * The orchestrator's final composed text (in `run_end.result.text`)
 * correctly contains ONLY the flow's reply. The bug is in the
 * `Assistant.run` consumer: it accumulates text_delta into
 * `captured.content` and never consults the orchestrator's authoritative
 * text in `run_end`.
 *
 * Fix: when `run_end` arrives, prefer its `result.text` (or scan
 * `result.events` for `agent_send_text`) and OVERRIDE the accumulated
 * `captured.content`. The text_delta streaming still feels live during
 * the turn; only the final captured-content snaps to the correct
 * orchestrator-composed text.
 *
 * Why not a faux-based integration test: Pi's auto-tool-loop emits
 * extra LLM-call boundaries (one per tool call's synthesis turn), so
 * scripting an exact response count is brittle. This unit test pins
 * the consumer's event-processing logic directly — the seam that the
 * real bug lives at — by simulating the SSE event stream byte-for-byte.
 */
import { describe, expect, it } from 'vitest';
import { Assistant } from '../src/assistant.ts';
import { localSandbox } from '../src/sandbox/local.ts';

/**
 * Build a fake-fetch that emits a controlled SSE event stream and
 * inject it via `_app` override so `Assistant.run` consumes our
 * scripted events instead of running a real orchestrator turn.
 */
function makeAssistantWithMockedWire(scriptedEvents: Array<Record<string, unknown>>): Assistant {
	const a = new Assistant({
		name: 'mock-bot',
		systemPrompt: 'x',
		mode: 'direct',
		model: 'mock/x',
		sandbox: false,
	});
	// Override the lazily-built FloeApp with one whose fetch returns
	// our scripted SSE response. We bypass _app() by stuffing _cached
	// directly via type assertion.
	const lines: string[] = [];
	for (const e of scriptedEvents) {
		lines.push(`data: ${JSON.stringify(e)}\n\n`);
	}
	lines.push('data: [DONE]\n\n');
	const fakeApp = {
		fetch: () =>
			new Response(new Blob([lines.join('')]).stream(), {
				status: 200,
				headers: { 'content-type': 'text/event-stream' },
			}),
		router: { route: () => undefined },
	};
	(a as unknown as { _cached: unknown })._cached = fakeApp;
	return a;
}

describe('flow-text-leak — Assistant.run consumer prefers orchestrator-composed text', () => {
	it('text_delta(host filler) + text_delta(flow reply) + run_end.result.text → only result.text wins', async () => {
		const a = makeAssistantWithMockedWire([
			{ type: 'run_start' },
			// Host LLM streams filler text BEFORE deciding to enter the flow.
			{ type: 'text_delta', text: "I'll check the timing of that drop for you. " },
			{ type: 'text_delta', text: 'Just a moment.' },
			// Flow's Reply node also streams via text_delta.
			{ type: 'text_delta', text: 'Drop of CS 351 confirmed — proceed.' },
			// The orchestrator's run_end has the AUTHORITATIVE final text.
			{
				type: 'run_end',
				result: {
					text: 'Drop of CS 351 confirmed — proceed.',
					events: [
						{ type: 'agent_send_text', text: 'Drop of CS 351 confirmed — proceed.', respondingTo: 'evt_1' },
					],
				},
			},
		]);
		const out = await a.run('drop cs 351', { sessionId: `leak-${crypto.randomUUID()}` });

		expect(out.content).toBe('Drop of CS 351 confirmed — proceed.');
		expect(out.content).not.toContain("I'll check the timing");
	});

	it('text_delta only, no run_end.result.text → falls back to accumulated deltas', async () => {
		const a = makeAssistantWithMockedWire([
			{ type: 'run_start' },
			{ type: 'text_delta', text: 'Hello, ' },
			{ type: 'text_delta', text: 'world!' },
			// No run_end at all — degenerate stream end.
		]);
		const out = await a.run('hi', { sessionId: `leak-${crypto.randomUUID()}` });
		expect(out.content).toBe('Hello, world!');
	});

	it('run_end with result.events containing agent_send_text → uses agent_send_text', async () => {
		const a = makeAssistantWithMockedWire([
			{ type: 'run_start' },
			{ type: 'text_delta', text: 'streamed filler text' },
			// result.text absent, but result.events has agent_send_text.
			{
				type: 'run_end',
				result: {
					events: [
						{ type: 'agent_send_text', text: 'authoritative final text', respondingTo: 'evt_2' },
					],
				},
			},
		]);
		const out = await a.run('hi', { sessionId: `leak-${crypto.randomUUID()}` });
		expect(out.content).toBe('authoritative final text');
	});

	it('run_end with empty result.text and no agent_send_text → keeps accumulated deltas', async () => {
		const a = makeAssistantWithMockedWire([
			{ type: 'run_start' },
			{ type: 'text_delta', text: 'deltas are all we have' },
			{ type: 'run_end', result: { text: '', events: [] } },
		]);
		const out = await a.run('hi', { sessionId: `leak-${crypto.randomUUID()}` });
		expect(out.content).toBe('deltas are all we have');
	});
});
