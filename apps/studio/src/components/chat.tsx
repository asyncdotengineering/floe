'use client';
import * as React from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationScrollButton,
} from '~/components/ai-elements/conversation';
import {
	Message,
	MessageContent,
	MessageResponse,
} from '~/components/ai-elements/message';
import {
	PromptInput,
	PromptInputBody,
	PromptInputFooter,
	PromptInputSubmit,
	PromptInputTextarea,
	PromptInputTools,
	type PromptInputMessage,
} from '~/components/ai-elements/prompt-input';
import { Suggestion, Suggestions } from '~/components/ai-elements/suggestion';
import {
	FlowBreadcrumb,
	SourcesInline,
	ToolCall,
	type FlowData,
	type SourceHit,
	type ToolCallData,
} from '~/components/tool-call';
import { getAgentUrl } from '~/lib/agent-config';
import { touchThreadWithUserMessage } from '~/lib/threads';

interface ChatProps {
	threadId: string;
	onAfterUserSend?: (firstUserText: string) => void;
}

const RESUME_STREAM_KEY = 'floe-studio:resume-stream-id';

const STARTER_PROMPTS = [
	'How do I request staging database access?',
	'Look up alice@acme.example and tell me her manager',
	"What's the on-call rotation?",
	'File a SECURITY ticket: I need staging DB for 5 days',
];

interface MessagePart {
	type: string;
	[k: string]: unknown;
}

/**
 * Pull custom data parts out of a v5 UIMessage. The proxy emits
 * `data-tool` and `data-source` frames; useChat collapses them into
 * the message's `parts` array as `{type:'data-tool', data:{...}}` and
 * `{type:'data-source', data:{...}}`.
 */
function dataPartsOf<T>(message: { parts: MessagePart[] }, kind: string): T[] {
	return message.parts
		.filter((p) => p.type === kind)
		.map((p) => (p as { data?: T }).data)
		.filter((d): d is T => d != null);
}

function textOf(message: { parts: MessagePart[] }): string {
	return message.parts
		.map((p) => (p.type === 'text' ? (p as { text?: string }).text ?? '' : ''))
		.join('');
}

export function Chat({ threadId, onAfterUserSend }: ChatProps): React.ReactElement {
	const agentName = import.meta.env.VITE_AGENT_NAME ?? 'Floe Agent';

	const transport = React.useMemo(
		() =>
			new DefaultChatTransport({
				api: '/api/chat',
				// Resolve the latest agent URL each request so the Settings
				// dialog's save (which fires window.location.reload anyway)
				// is reflected. body is a function so it re-evaluates per send.
				body: () => ({ sessionId: threadId, agentUrl: getAgentUrl() }),
				fetch: async (input, init) => {
					const res = await fetch(input, init);
					const id = res.headers.get('x-resume-stream-id');
					if (id) {
						try {
							window.localStorage.setItem(RESUME_STREAM_KEY, id);
						} catch {
							// no-op
						}
					}
					return res;
				},
			}),
		[threadId],
	);

	const { messages, sendMessage, status, error, stop } = useChat({
		id: threadId,
		transport,
		onFinish() {
			try {
				window.localStorage.removeItem(RESUME_STREAM_KEY);
			} catch {
				// no-op
			}
		},
	});

	const isStreaming = status === 'submitted' || status === 'streaming';

	function handleSubmit(message: PromptInputMessage) {
		const text = (message.text ?? '').trim();
		if (!text) return;
		touchThreadWithUserMessage(threadId, text);
		onAfterUserSend?.(text);
		sendMessage({ text });
	}

	function handleSuggestion(text: string) {
		touchThreadWithUserMessage(threadId, text);
		onAfterUserSend?.(text);
		sendMessage({ text });
	}

	const hasMessages = messages.length > 0;

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex shrink-0 items-center justify-between border-b px-4 py-3">
				<div>
					<div className="text-sm font-semibold">{agentName}</div>
					<div className="font-mono text-[10px] text-muted-foreground">
						thread {threadId.slice(0, 14)}…
					</div>
				</div>
				{isStreaming && (
					<button
						type="button"
						onClick={() => stop()}
						className="rounded-md border px-2 py-1 text-[11px] hover:bg-muted"
					>
						Stop
					</button>
				)}
			</header>

			<Conversation className="flex-1 min-h-0">
				<ConversationContent>
					{!hasMessages ? (
						<ConversationEmptyState
							title="What can I help with?"
							description={`Connected to ${agentName}. Type a message below, or try one of the starters.`}
						/>
					) : (
						messages.map((m) => {
							const role = m.role as 'user' | 'assistant';
							const text = textOf(m);
							const tools = dataPartsOf<ToolCallData>(m, 'data-tool');
							const sources = dataPartsOf<SourceHit>(m, 'data-source');
							const flows = dataPartsOf<FlowData>(m, 'data-flow');
							return (
								<Message key={m.id} from={role}>
									<div className="flex max-w-[85%] flex-col gap-1">
										{flows.length > 0 && (
											<div className="space-y-1">
												{flows.map((f, i) => (
													<FlowBreadcrumb key={`flow-${i}`} data={f} />
												))}
											</div>
										)}
										{tools.length > 0 && (
											<div className="space-y-1">
												{tools.map((t) => (
													<ToolCall key={t.toolCallId} data={t} />
												))}
											</div>
										)}
										{sources.length > 0 && <SourcesInline items={sources} />}
										{text && (
											<MessageContent>
												<MessageResponse>{text}</MessageResponse>
											</MessageContent>
										)}
									</div>
								</Message>
							);
						})
					)}
				</ConversationContent>
				<ConversationScrollButton />
			</Conversation>

			{!hasMessages && (
				<div className="px-4 pb-2">
					<Suggestions>
						{STARTER_PROMPTS.map((p) => (
							<Suggestion key={p} suggestion={p} onClick={handleSuggestion} />
						))}
					</Suggestions>
				</div>
			)}

			{error && (
				<div className="mx-auto w-full max-w-3xl px-4">
					<div className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
						{error.message}
					</div>
				</div>
			)}

			<div className="border-t bg-background/95 px-4 py-3">
				<PromptInput onSubmit={handleSubmit}>
					<PromptInputBody>
						<PromptInputTextarea
							placeholder={`Message ${agentName}…`}
							disabled={isStreaming}
						/>
					</PromptInputBody>
					<PromptInputFooter>
						<PromptInputTools />
						<PromptInputSubmit
							disabled={isStreaming}
							status={isStreaming ? 'streaming' : 'ready'}
						/>
					</PromptInputFooter>
				</PromptInput>
			</div>
		</div>
	);
}
