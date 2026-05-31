/**
 * The Floe class — the single registry.
 *
 * Instantiated once at module init (or per project). Its `.handler({channel})`
 * method returns a function compatible with Flue's `AgentHandler` signature.
 */
import type { FlueContext } from '@flue/runtime';
import type { Channel, FloeConfig } from './types.ts';
import { runAssistantTurn } from './orchestrator.ts';

export interface HandlerOptions {
	/** The channel name to dispatch as. Required. */
	channel: string;
	/**
	 * Override the assistant to invoke. If unset, Floe uses the inbound
	 * event's `assistantName` field, then falls back to the first registered
	 * assistant.
	 */
	assistant?: string;
}

export type FlueAgentHandler = (ctx: FlueContext) => Promise<unknown>;

export class Floe {
	readonly config: FloeConfig;

	constructor(config: FloeConfig) {
		this.config = freezeConfig(config);
		validateConfig(this.config);
	}

	/**
	 * Build a Flue-compatible handler for a specific channel. The handler
	 * receives a Flue request, dispatches via the channel adapter into the
	 * orchestrator, and returns the assistant text + events + state.
	 */
	handler(opts: HandlerOptions): FlueAgentHandler {
		const channel = this.config.channels[opts.channel];
		if (!channel) {
			throw new Error(
				`[floe] Channel "${opts.channel}" not registered. Available: ${Object.keys(this.config.channels).join(', ') || '(none)'}`,
			);
		}

		return async (ctx: FlueContext): Promise<unknown> => {
			const input = await channel.parseInbound(ctx);
			const inputAssistantName =
				input.type === 'user_text_sent' ? input.assistantName : undefined;
			const assistantName =
				opts.assistant ??
				inputAssistantName ??
				Object.keys(this.config.assistants)[0];
			if (!assistantName) {
				throw new Error('[floe] No assistant registered');
			}
			const convo = this.config.assistants[assistantName];
			if (!convo) {
				throw new Error(
					`[floe] Assistant "${assistantName}" not registered. Available: ${Object.keys(this.config.assistants).join(', ')}`,
				);
			}

			const result = await runAssistantTurn({
				ctx,
				convo,
				channel,
				defaults: this.config.defaults,
				...(this.config.assistantStateStore
					? { assistantStateStore: this.config.assistantStateStore }
					: {}),
				...(this.config.transcriptStore ? { transcriptStore: this.config.transcriptStore } : {}),
			});

			return {
				text: result.text,
				events: result.events,
				state: result.state,
			};
		};
	}
}

function freezeConfig(config: FloeConfig): FloeConfig {
	return Object.freeze({
		assistants: Object.freeze({ ...config.assistants }),
		channels: Object.freeze({ ...config.channels }),
		defaults: Object.freeze({ ...config.defaults }),
		...(config.assistantStateStore
			? { assistantStateStore: config.assistantStateStore }
			: {}),
		...(config.transcriptStore ? { transcriptStore: config.transcriptStore } : {}),
	});
}

function validateConfig(config: FloeConfig): void {
	if (Object.keys(config.assistants).length === 0) {
		throw new Error('[floe] At least one assistant must be registered.');
	}
	if (Object.keys(config.channels).length === 0) {
		throw new Error('[floe] At least one channel must be registered.');
	}
	for (const [name, convo] of Object.entries(config.assistants)) {
		if (!convo.systemPrompt || convo.systemPrompt.trim() === '') {
			throw new Error(`[floe] Assistant "${name}" has no systemPrompt.`);
		}
		if (convo.roles) {
			for (const roleName of Object.keys(convo.roles)) {
				if (!convo.roles[roleName]?.instructions) {
					throw new Error(
						`[floe] Assistant "${name}" role "${roleName}" has no instructions.`,
					);
				}
			}
		}
	}
}

// Re-export the Channel type-guard so users can build their own.
export type { Channel } from './types.ts';
