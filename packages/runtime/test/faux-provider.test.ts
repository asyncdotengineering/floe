/**
 * End-to-end tests for the faux LLM provider. These tests run REAL
 * Assistant turns — flowing through `prepare-turn → retrieve → respond`,
 * the full orchestrator pipeline — but the LLM step is served by Pi's
 * faux provider with scripted responses. Zero LLM cost, deterministic
 * outputs, full structural coverage.
 *
 * If these tests pass, the faux helper is working end-to-end: a user
 * can register their own faux for any test they want.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
	registerFloeFaux,
	fauxAssistantMessage,
	fauxText,
	type FloeFauxHandle,
} from '../src/testing/faux.ts';
import { Assistant } from '../src/assistant.ts';

let faux: FloeFauxHandle | null = null;

afterEach(() => {
	if (faux) {
		faux.unregister();
		faux = null;
	}
});

describe('registerFloeFaux — end-to-end with a real Assistant', () => {
	it('serves a scripted response to session.prompt via assistant.run', async () => {
		faux = registerFloeFaux({
			provider: 'faux-e2e-1',
			models: [{ id: 'test' }],
			responses: [fauxAssistantMessage('Hello from faux!')],
		});

		const assistant = new Assistant({
			name: 'test',
			systemPrompt: 'You are a test assistant.',
			mode: 'direct',
			model: 'faux-e2e-1/test',
			sandbox: false,
		});

		const handle = assistant.run('hi', { sessionId: 'test-session-1' });
		const out = await handle;
		expect(out.content).toContain('Hello from faux!');
		expect(faux.callCount()).toBe(1);
		expect(faux.getPending()).toBe(0);
	});

	it('serves successive responses in FIFO order', async () => {
		faux = registerFloeFaux({
			provider: 'faux-e2e-2',
			responses: [
				fauxAssistantMessage('First reply'),
				fauxAssistantMessage('Second reply'),
				fauxAssistantMessage('Third reply'),
			],
		});

		const assistant = new Assistant({
			name: 'test2',
			systemPrompt: 'You are a test.',
			mode: 'direct',
			model: 'faux-e2e-2/test',
			sandbox: false,
		});

		const r1 = await assistant.run('msg1', { sessionId: 's-2' });
		const r2 = await assistant.run('msg2', { sessionId: 's-2' });
		const r3 = await assistant.run('msg3', { sessionId: 's-2' });

		expect(r1.content).toContain('First reply');
		expect(r2.content).toContain('Second reply');
		expect(r3.content).toContain('Third reply');
		expect(faux.callCount()).toBe(3);
		expect(faux.getPending()).toBe(0);
	});

	it('factory responses see the request context — can inspect what was asked', async () => {
		const seenMessages: string[] = [];
		faux = registerFloeFaux({
			provider: 'faux-e2e-3',
			responses: [
				(ctx) => {
					// Record what the model "saw" so we can assert on it.
					const lastUser = ctx.messages
						.filter((m) => m.role === 'user')
						.pop();
					const text =
						lastUser && Array.isArray(lastUser.content)
							? lastUser.content
									.filter((b) => b.type === 'text')
									.map((b) => (b as { text: string }).text)
									.join('')
							: '';
					seenMessages.push(text);
					return fauxAssistantMessage(`Echo: ${text}`);
				},
			],
		});

		const assistant = new Assistant({
			name: 'test3',
			systemPrompt: 'You echo user messages.',
			mode: 'direct',
			model: 'faux-e2e-3/test',
			sandbox: false,
		});

		const out = await assistant.run('the actual message', { sessionId: 's-3' });
		expect(out.content).toContain('Echo: the actual message');
		expect(seenMessages).toHaveLength(1);
		expect(seenMessages[0]).toContain('the actual message');
	});

	it('appendResponses adds to the queue without resetting', async () => {
		faux = registerFloeFaux({
			provider: 'faux-e2e-4',
			responses: [fauxAssistantMessage('one')],
		});
		expect(faux.getPending()).toBe(1);
		faux.appendResponses([
			fauxAssistantMessage('two'),
			fauxAssistantMessage('three'),
		]);
		expect(faux.getPending()).toBe(3);
	});

	it('setResponses replaces the queue (drops pending)', async () => {
		faux = registerFloeFaux({
			provider: 'faux-e2e-5',
			responses: [
				fauxAssistantMessage('a'),
				fauxAssistantMessage('b'),
				fauxAssistantMessage('c'),
			],
		});
		expect(faux.getPending()).toBe(3);
		faux.setResponses([fauxAssistantMessage('replaced')]);
		expect(faux.getPending()).toBe(1);
	});

	it('unregister tears down cleanly — re-register works without conflict', () => {
		const a = registerFloeFaux({
			provider: 'faux-cycle',
			responses: [fauxAssistantMessage('a')],
		});
		a.unregister();
		// Re-register with the same provider slug. Should not throw.
		const b = registerFloeFaux({
			provider: 'faux-cycle',
			responses: [fauxAssistantMessage('b')],
		});
		b.unregister();
		// Test passes if neither call threw.
		expect(true).toBe(true);
	});

	it('multi-model definitions: address different model ids under one provider', async () => {
		faux = registerFloeFaux({
			provider: 'faux-multi',
			models: [{ id: 'fast' }, { id: 'smart' }],
			responses: [
				fauxAssistantMessage('fast reply'),
				fauxAssistantMessage('smart reply'),
			],
		});

		const fast = new Assistant({
			name: 'fast', systemPrompt: 's', mode: 'direct',
			model: 'faux-multi/fast', sandbox: false,
		});
		const smart = new Assistant({
			name: 'smart', systemPrompt: 's', mode: 'direct',
			model: 'faux-multi/smart', sandbox: false,
		});

		const r1 = await fast.run('hi', { sessionId: 's-fast' });
		const r2 = await smart.run('hi', { sessionId: 's-smart' });
		expect(r1.content).toContain('fast reply');
		expect(r2.content).toContain('smart reply');
	});

	it('FauxResponseStep supports text-only shorthand via fauxText() block', async () => {
		faux = registerFloeFaux({
			provider: 'faux-text-block',
			responses: [
				fauxAssistantMessage([fauxText('Block-form text content.')]),
			],
		});
		const a = new Assistant({
			name: 't', systemPrompt: 's', mode: 'direct',
			model: 'faux-text-block/test', sandbox: false,
		});
		const out = await a.run('hi', { sessionId: 's' });
		expect(out.content).toContain('Block-form text content.');
	});
});
