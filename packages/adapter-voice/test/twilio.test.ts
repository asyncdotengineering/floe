/**
 * Boundary tests for the Twilio voice webhook helper. The webhook
 * speaks TwiML over HTTP, so tests verify the XML structure + that
 * a SpeechResult triggers a real Assistant.run.
 */
import { describe, expect, it } from 'vitest';
import { twilioVoiceWebhook } from '../src/twilio.ts';
import type { Assistant } from '@floe/runtime';

function fakeAssistant(replyContent: string, captureMessages?: string[]): Assistant {
	return {
		run: (message: string, _args: Record<string, unknown>) => {
			captureMessages?.push(message);
			return Promise.resolve({
				runId: 'r',
				sessionId: 's',
				content: replyContent,
				messages: [],
				mode: 'direct',
				interrupted: false,
			});
		},
	} as unknown as Assistant;
}

function formReq(form: Record<string, string>): Request {
	const body = new URLSearchParams(form).toString();
	return new Request('http://t/voice', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body,
	});
}

describe('twilioVoiceWebhook', () => {
	it('first call (no SpeechResult) plays the greeting + opens Gather', async () => {
		const h = twilioVoiceWebhook({
			assistant: fakeAssistant('unused'),
			actionUrl: 'https://my-host/voice',
			greeting: 'Hello from test',
		});
		const res = await h(formReq({ CallSid: 'CA-1', From: '+1-415' }));
		const xml = await res.text();
		expect(res.headers.get('content-type')).toContain('application/xml');
		expect(xml).toContain('<Say');
		expect(xml).toContain('Hello from test');
		expect(xml).toContain('<Gather');
		expect(xml).toContain('action="https://my-host/voice"');
	});

	it('SpeechResult drives Assistant.run + speaks the reply', async () => {
		const messages: string[] = [];
		const h = twilioVoiceWebhook({
			assistant: fakeAssistant("Here's your answer.", messages),
			actionUrl: 'https://my-host/voice',
		});
		const res = await h(
			formReq({ CallSid: 'CA-2', From: '+1-415', SpeechResult: 'check my account' }),
		);
		const xml = await res.text();
		expect(messages).toEqual(['check my account']);
		expect(xml).toContain("Here&apos;s your answer.");
		expect(xml).toContain('<Gather');
	});

	it('rejects non-POST', async () => {
		const h = twilioVoiceWebhook({
			assistant: fakeAssistant('x'),
			actionUrl: 'https://my-host/voice',
		});
		const res = await h(new Request('http://t/voice', { method: 'GET' }));
		expect(res.status).toBe(405);
	});

	it('escapes XML metacharacters in the spoken reply', async () => {
		const h = twilioVoiceWebhook({
			assistant: fakeAssistant('hello <b>world</b> & "friend"'),
			actionUrl: 'https://my-host/voice',
		});
		const res = await h(formReq({ CallSid: 'CA-3', From: '+1', SpeechResult: 'hi' }));
		const xml = await res.text();
		expect(xml).toContain('&lt;b&gt;');
		expect(xml).toContain('&amp;');
		expect(xml).toContain('&quot;');
		// must NOT contain raw '<b>' which would be a TwiML syntax break
		expect(xml).not.toContain('<b>world</b>');
	});
});
