/**
 * Boundary tests for `voiceAdapter`. We stub Assistant.run with an
 * async events iterable + a resolvable promise, and verify:
 *   - bad input → 400
 *   - happy path → SSE with `event: sentence` per flushed sentence + final `event: done`
 *   - resolveUserId is wired
 *   - channel hint is set + voice overlay propagates
 */
import { describe, expect, it } from 'vitest';
import { voiceAdapter } from '../src/index.ts';
import type { Assistant, TurnHandle } from '@floe/runtime';

interface FakeRun {
	events: string[];
	final: string;
	runId?: string;
}

function fakeAssistant(behavior: FakeRun, capture?: {
	calls: Array<{ message: string; args: Record<string, unknown> }>;
}): Assistant {
	return {
		run: (message: string, args: Record<string, unknown>): TurnHandle => {
			capture?.calls.push({ message, args });
			let resolveAwait: ((out: unknown) => void) | null = null;
			const promise = new Promise<unknown>((r) => {
				resolveAwait = r;
			});
			const handle = promise as unknown as TurnHandle;
			Object.defineProperty(handle, 'events', {
				value: (async function* () {
					for (const text of behavior.events) {
						yield { type: 'agent_send_partial', delta: text, respondingTo: 'evt' } as never;
					}
					resolveAwait!({
						runId: behavior.runId ?? 'r-1',
						sessionId: String(args.sessionId ?? ''),
						content: behavior.final,
						messages: [],
						mode: 'direct',
						interrupted: false,
					});
				})(),
			});
			handle.cancel = () => {};
			return handle;
		},
	} as unknown as Assistant;
}

async function readSse(res: Response): Promise<Array<{ event: string; data: unknown }>> {
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	const out: Array<{ event: string; data: unknown }> = [];
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const blocks = buffer.split('\n\n');
		buffer = blocks.pop() ?? '';
		for (const b of blocks) {
			const eventLine = b.split('\n').find((l) => l.startsWith('event: '));
			const dataLine = b.split('\n').find((l) => l.startsWith('data: '));
			if (!eventLine || !dataLine) continue;
			out.push({
				event: eventLine.slice('event: '.length),
				data: JSON.parse(dataLine.slice('data: '.length)),
			});
		}
	}
	return out;
}

describe('voiceAdapter — input validation', () => {
	it('rejects non-POST → 405', async () => {
		const h = voiceAdapter({ assistant: fakeAssistant({ events: [], final: '' }) });
		const res = await h(new Request('http://t/v', { method: 'GET' }));
		expect(res.status).toBe(405);
	});
	it('rejects bad JSON → 400', async () => {
		const h = voiceAdapter({ assistant: fakeAssistant({ events: [], final: '' }) });
		const res = await h(
			new Request('http://t/v', { method: 'POST', body: 'not-json', headers: { 'content-type': 'application/json' } }),
		);
		expect(res.status).toBe(400);
	});
	it('rejects missing sessionId → 400', async () => {
		const h = voiceAdapter({ assistant: fakeAssistant({ events: [], final: '' }) });
		const res = await h(
			new Request('http://t/v', { method: 'POST', body: JSON.stringify({ transcript: 'hi' }) }),
		);
		expect(res.status).toBe(400);
	});
	it('rejects missing transcript → 400', async () => {
		const h = voiceAdapter({ assistant: fakeAssistant({ events: [], final: '' }) });
		const res = await h(
			new Request('http://t/v', { method: 'POST', body: JSON.stringify({ sessionId: 's' }) }),
		);
		expect(res.status).toBe(400);
	});
});

describe('voiceAdapter — happy path', () => {
	it('streams one sentence-event per flushed sentence + final done', async () => {
		const h = voiceAdapter({
			assistant: fakeAssistant({
				events: ['Got ', 'it. ', 'Let me ', 'check that.'],
				final: 'Got it. Let me check that.',
				runId: 'r-42',
			}),
		});
		const res = await h(
			new Request('http://t/v', {
				method: 'POST',
				body: JSON.stringify({ sessionId: 'sess-1', transcript: 'hello' }),
				headers: { 'content-type': 'application/json' },
			}),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/event-stream');
		expect(res.headers.get('x-floe-channel')).toBe('voice');
		const events = await readSse(res);
		const sentences = events
			.filter((e) => e.event === 'sentence')
			.map((e) => (e.data as { text: string }).text);
		expect(sentences).toEqual(['Got it.', 'Let me check that.']);
		const doneEvent = events.find((e) => e.event === 'done');
		expect((doneEvent?.data as { runId: string }).runId).toBe('r-42');
	});

	it('flushes trailing remainder when assistant ends without punctuation', async () => {
		const h = voiceAdapter({
			assistant: fakeAssistant({
				events: ['No terminator here'],
				final: 'No terminator here',
			}),
		});
		const res = await h(
			new Request('http://t/v', {
				method: 'POST',
				body: JSON.stringify({ sessionId: 's', transcript: 'go' }),
				headers: { 'content-type': 'application/json' },
			}),
		);
		const events = await readSse(res);
		const sentences = events.filter((e) => e.event === 'sentence').map((e) => (e.data as { text: string }).text);
		expect(sentences).toEqual(['No terminator here']);
	});
});

describe('voiceAdapter — wiring', () => {
	it('threads resolveUserId result into the run', async () => {
		const calls: Array<{ message: string; args: Record<string, unknown> }> = [];
		const h = voiceAdapter({
			assistant: fakeAssistant({ events: ['ok.'], final: 'ok.' }, { calls }),
			resolveUserId: (m) => (m?.['phone'] ? `pt_for_${m['phone']}` : undefined),
		});
		await h(
			new Request('http://t/v', {
				method: 'POST',
				body: JSON.stringify({
					sessionId: 'sess',
					transcript: 'hi',
					metadata: { phone: '+1-415-555-0000' },
				}),
				headers: { 'content-type': 'application/json' },
			}),
		);
		// Drain the stream so the run actually fires
		await new Promise((r) => setTimeout(r, 5));
		expect(calls[0]!.args.userId).toBe('pt_for_+1-415-555-0000');
		expect((calls[0]!.args.metadata as Record<string, unknown>).channel).toBe('voice');
		const overlay = calls[0]!.args.overlay as Record<string, unknown>;
		expect(overlay.sequentialToolUse).toBe(true);
		expect(overlay.maxResponseTokens).toBe(100);
	});
});
