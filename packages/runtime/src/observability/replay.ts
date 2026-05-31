/**
 * Assistant turn replay. Given a sequence of AssistantOutputEvents
 * captured from a turn (or a session), re-emit them to an observer in
 * order. Useful for:
 *
 *   - Debug tooling — step through what happened in a failed turn
 *   - Integration tests — replay a captured run and assert observers behave
 *   - Time-travel UIs — re-render a transcript with side panels
 *
 * Does not call any LLMs; pure event-replay. Reads `AssistantView`-
 * shaped state if you want to thread state through your observer.
 */
import type { AssistantOutputEvent, AssistantState } from '../types.ts';

export interface ReplayOptions {
	/** Optional delay between events in ms (so a UI sees realistic pacing). 0 = burst. */
	intervalMs?: number;
	/** Observer that receives each event in order. */
	onEvent: (event: AssistantOutputEvent, ctx: ReplayContext) => void | Promise<void>;
	/** Initial state seed. */
	state?: AssistantState;
}

export interface ReplayContext {
	/** 0-based index of the current event. */
	index: number;
	/** Total number of events that will be replayed. */
	total: number;
	/** Same state object across the whole replay. */
	state: AssistantState | null;
}

export async function replayEvents(
	events: AssistantOutputEvent[],
	opts: ReplayOptions,
): Promise<void> {
	const total = events.length;
	const ctx: ReplayContext = {
		index: 0,
		total,
		state: opts.state ?? null,
	};
	for (let i = 0; i < total; i++) {
		ctx.index = i;
		await opts.onEvent(events[i]!, ctx);
		if (opts.intervalMs && i < total - 1) {
			await new Promise((r) => setTimeout(r, opts.intervalMs));
		}
	}
}

/**
 * Convenience: produce a transcript view (user lines + assistant lines)
 * from a replay of events. Skips internal events (validator results,
 * tool calls). Useful for "show me what the customer saw."
 */
export function transcriptFromEvents(events: AssistantOutputEvent[]): Array<{
	role: 'user' | 'assistant';
	text: string;
}> {
	const out: Array<{ role: 'user' | 'assistant'; text: string }> = [];
	for (const e of events) {
		if (e.type === 'agent_send_text') {
			out.push({ role: 'assistant', text: e.text });
		}
	}
	return out;
}
