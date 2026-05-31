/**
 * Internal web channel — shared by `Assistant.run()` (programmatic
 * dispatch) and `@floe/adapter-web` (HTTP mount). Not exported from
 * the main `@floe/runtime` entry; only via `/internal` for adapter
 * authors.
 */
import type { FlueContext } from '@flue/runtime';
import { defineChannel } from './define.ts';
import type { AssistantInputEvent } from './types.ts';

let counter = 0;
function freshEventId(): string {
	counter += 1;
	return `evt_${Date.now()}_${counter}`;
}

export const webChannel = defineChannel({
	name: 'web-chat',
	kind: 'http',
	async parseInbound(ctx: FlueContext): Promise<AssistantInputEvent> {
		const payload = ctx.payload as {
			message?: string;
			assistantName?: string;
			metadata?: Record<string, unknown>;
		};
		return {
			type: 'user_text_sent',
			content: payload?.message ?? '',
			eventId: freshEventId(),
			assistantName: payload?.assistantName,
			metadata: payload?.metadata,
		};
	},
	defaultOverlay: {},
	isVoiceTurn(ctx: FlueContext): boolean {
		return ctx.req?.headers.get('x-floe-channel') === 'voice';
	},
});
