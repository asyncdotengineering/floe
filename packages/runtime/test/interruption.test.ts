/**
 * End-to-end interruption tests — exercise runAssistantTurn's
 * abort/supersede path through the full orchestrator (prepare → retrieve
 * → respond → finalize). No real LLM; session.prompt is stubbed to
 * respect AbortSignal.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { runAssistantTurn } from '../src/orchestrator/index.ts';
import { __resetTurnRegistryForTests } from '../src/orchestrator/turn-registry.ts';
import type {
	Channel,
	AssistantConfig,
	AssistantOutputEvent,
	FloeConfig,
} from '../src/types.ts';

function makeChannel(): Channel {
	return {
		name: 'web',
		kind: 'http' as const,
		async parseInbound() {
			return { type: 'user_text_sent' as const, content: 'hello', eventId: 'evt-1' };
		},
	};
}

function makeConvo(): AssistantConfig {
	return {
		name: 'test',
		agents: [{ id: 'greeter', description: 'g', systemPrompt: 'You greet.' }],
		triage: 'first-agent',
	};
}

function makeCtx(opts: { runId: string; sessionId: string; req?: Request; prompt: (signal?: AbortSignal) => Promise<{ text: string }> }) {
	return {
		id: opts.sessionId,
		runId: opts.runId,
		req: opts.req,
		init: async () => ({
			session: async () => ({
				name: 'sess',
				// `config.systemPrompt` mirrors Flue's Session.config field
				// that `floePrompt` mutates. Without it the strict-mode
				// throw in `_internal_applySystemPromptSlot` fires (by
				// design — silent degradation would hide a real bug).
				config: { systemPrompt: '' },
				prompt: async (_text: string, options: { signal?: AbortSignal }) => {
					return opts.prompt(options?.signal);
				},
			}),
		}),
	};
}

const defaults: FloeConfig['defaults'] = { model: 'test', sandbox: false };

describe('runAssistantTurn interruption', () => {
	afterEach(() => __resetTurnRegistryForTests());

	it('aborts a turn when the inbound request signal fires', async () => {
		const requestController = new AbortController();
		const ctx = makeCtx({
			sessionId: 'sess-A',
			runId: 'run-A',
			req: new Request('http://x.test/', { signal: requestController.signal }),
			async prompt(signal) {
				await new Promise<void>((resolve, reject) => {
					if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
					const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
					signal?.addEventListener('abort', onAbort, { once: true });
				});
				return { text: 'never reached' };
			},
		});

		// Fire the abort shortly after starting the turn.
		setTimeout(() => requestController.abort(new DOMException('Client closed', 'AbortError')), 20);

		const result = await runAssistantTurn({
			ctx: ctx as never,
			convo: makeConvo(),
			channel: makeChannel(),
			defaults,
		});

		expect(result.text).toBe('');
		expect(result.respondingTo).toBe('turn-interrupted');
		const interruptedEvent = result.events.find(
			(e): e is Extract<AssistantOutputEvent, { type: 'conversation_event' }> =>
				e.type === 'conversation_event' && e.subtype === 'turn_interrupted',
		);
		expect(interruptedEvent).toBeDefined();
		expect(interruptedEvent!.data.reason).toBe('aborted');
	});

	it('a second turn on the same sessionId supersedes the first', async () => {
		const ctxA = makeCtx({
			sessionId: 'sess-S',
			runId: 'run-A',
			async prompt(signal) {
				await new Promise<void>((resolve, reject) => {
					if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
					signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
				});
				return { text: 'never reached' };
			},
		});
		const ctxB = makeCtx({
			sessionId: 'sess-S',
			runId: 'run-B',
			async prompt() {
				return { text: 'B wins' };
			},
		});

		const promiseA = runAssistantTurn({
			ctx: ctxA as never,
			convo: makeConvo(),
			channel: makeChannel(),
			defaults,
		});
		// Let A start the inner await.
		await new Promise((r) => setTimeout(r, 10));
		const resultB = await runAssistantTurn({
			ctx: ctxB as never,
			convo: makeConvo(),
			channel: makeChannel(),
			defaults,
		});
		const resultA = await promiseA;

		expect(resultA.respondingTo).toBe('turn-interrupted');
		const intEvent = resultA.events.find(
			(e): e is Extract<AssistantOutputEvent, { type: 'conversation_event' }> =>
				e.type === 'conversation_event' && e.subtype === 'turn_interrupted',
		);
		expect(intEvent?.data.reason).toBe('superseded');
		expect(resultB.text).toBe('B wins');
	});

	it('non-abort errors are not swallowed by the interruption handler', async () => {
		const ctx = makeCtx({
			sessionId: 'sess-E',
			runId: 'run-E',
			async prompt() {
				throw new Error('LLM exploded');
			},
		});
		await expect(
			runAssistantTurn({
				ctx: ctx as never,
				convo: makeConvo(),
				channel: makeChannel(),
				defaults,
			}),
		).rejects.toThrow(/LLM exploded/);
	});
});
