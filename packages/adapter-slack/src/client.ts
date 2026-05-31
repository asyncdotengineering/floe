/**
 * Tiny Slack Web API client — just the surface adapter-slack actually
 * uses (chat.postMessage). No dependency on @slack/web-api so the
 * adapter stays light. Users wanting more (files, conversations,
 * users.profile) can wire @slack/web-api themselves alongside.
 */

export interface SlackPostMessageArgs {
	channel: string;
	text: string;
	threadTs?: string;
	blocks?: unknown[];
	unfurlLinks?: boolean;
	unfurlMedia?: boolean;
}

export interface SlackPostMessageResult {
	ok: boolean;
	ts?: string;
	channel?: string;
	error?: string;
}

export interface SlackClient {
	postMessage(args: SlackPostMessageArgs): Promise<SlackPostMessageResult>;
}

export interface CreateSlackClientOptions {
	botToken: string;
	/** Override fetch (testing). Default global fetch. */
	fetch?: typeof fetch;
	baseUrl?: string;
}

export function createSlackClient(opts: CreateSlackClientOptions): SlackClient {
	const fetchImpl = opts.fetch ?? fetch;
	const baseUrl = opts.baseUrl ?? 'https://slack.com/api';
	return {
		async postMessage(args) {
			const body: Record<string, unknown> = {
				channel: args.channel,
				text: args.text,
			};
			if (args.threadTs) body.thread_ts = args.threadTs;
			if (args.blocks) body.blocks = args.blocks;
			if (typeof args.unfurlLinks === 'boolean') body.unfurl_links = args.unfurlLinks;
			if (typeof args.unfurlMedia === 'boolean') body.unfurl_media = args.unfurlMedia;

			const res = await fetchImpl(`${baseUrl}/chat.postMessage`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json; charset=utf-8',
					authorization: `Bearer ${opts.botToken}`,
				},
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				return { ok: false, error: `http_${res.status}` };
			}
			const json = (await res.json()) as SlackPostMessageResult;
			return json;
		},
	};
}
