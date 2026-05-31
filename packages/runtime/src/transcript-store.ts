/**
 * TranscriptStore — durable, user-renderable conversation history.
 *
 * Distinct from the SessionStore (raw `SessionData.entries` Flue persists,
 * which includes triage prompts, knowledge chunks, tool calls, judge LLM
 * responses — verbose, not for frontends) and from the AssistantStateStore
 * (Floe's per-conversation auxiliary state). This store is the clean
 * `[{role, content}]` shape a chat UI renders.
 *
 * The message shape is the AI SDK `UIMessage` discriminated-by-`parts[]`
 * format — the de-facto standard across Vercel `useChat`, OpenAI's
 * Conversations API, and Cloudflare Agents' `useAgentChat` hook. Frontends
 * that consume Floe's `/history/:sessionId` endpoint work with zero
 * adapter code.
 *
 * Default impl (`InMemoryTranscriptStore`) is process-local; users wire
 * Turso / Postgres / Redis for durability. When a store is configured
 * on the Assistant (`state.transcriptStore`), the framework auto-mounts
 * three HTTP routes:
 *   GET    /history/:sessionId          — list one session's messages
 *   GET    /history/user/:userId        — list a user's sessions (preview)
 *   DELETE /history/:sessionId          — GDPR right-to-be-forgotten
 */

/**
 * Minimal `UIMessage` shape — structurally compatible with the `ai`
 * package's `UIMessage` type but doesn't require the dep. Frontends that
 * import `UIMessage` from `ai` will satisfy this interface.
 */
export interface TranscriptMessage {
	id: string;
	role: 'user' | 'assistant' | 'system';
	parts: Array<{ type: 'text'; text: string }>;
	createdAt: number;
	/** Optional user scoping. Used to filter cross-session memory by user. */
	userId?: string;
}

export interface TranscriptSession {
	sessionId: string;
	lastTurnAt: number;
	turnCount: number;
	preview: string;
	userId?: string;
}

export interface TranscriptListResult {
	messages: TranscriptMessage[];
	nextCursor: string | null;
}

export interface TranscriptListSessionsResult {
	sessions: TranscriptSession[];
}

export interface TranscriptStore {
	append(sessionId: string, message: TranscriptMessage): Promise<void>;
	list(sessionId: string, opts?: { limit?: number; cursor?: string }): Promise<TranscriptListResult>;
	listSessions(userId: string, opts?: { limit?: number }): Promise<TranscriptListSessionsResult>;
	delete(sessionId: string): Promise<void>;
}

export class InMemoryTranscriptStore implements TranscriptStore {
	private readonly bySession = new Map<string, TranscriptMessage[]>();

	async append(sessionId: string, message: TranscriptMessage): Promise<void> {
		const list = this.bySession.get(sessionId) ?? [];
		list.push(message);
		this.bySession.set(sessionId, list);
	}

	async list(
		sessionId: string,
		opts: { limit?: number; cursor?: string } = {},
	): Promise<TranscriptListResult> {
		const all = this.bySession.get(sessionId) ?? [];
		const startIdx = opts.cursor ? Number.parseInt(opts.cursor, 10) || 0 : 0;
		const limit = opts.limit ?? 100;
		const slice = all.slice(startIdx, startIdx + limit);
		const nextIdx = startIdx + slice.length;
		return {
			messages: slice,
			nextCursor: nextIdx < all.length ? String(nextIdx) : null,
		};
	}

	async listSessions(
		userId: string,
		opts: { limit?: number } = {},
	): Promise<TranscriptListSessionsResult> {
		const limit = opts.limit ?? 50;
		const sessions: TranscriptSession[] = [];
		for (const [sessionId, msgs] of this.bySession.entries()) {
			const userMsgs = msgs.filter((m) => m.userId === userId);
			if (userMsgs.length === 0) continue;
			const last = userMsgs[userMsgs.length - 1]!;
			const firstText = userMsgs[0]?.parts?.[0];
			const preview =
				firstText && firstText.type === 'text' ? firstText.text.slice(0, 80) : '';
			sessions.push({
				sessionId,
				lastTurnAt: last.createdAt,
				turnCount: userMsgs.length,
				preview,
				userId,
			});
		}
		sessions.sort((a, b) => b.lastTurnAt - a.lastTurnAt);
		return { sessions: sessions.slice(0, limit) };
	}

	async delete(sessionId: string): Promise<void> {
		this.bySession.delete(sessionId);
	}
}

/**
 * Build a `TranscriptMessage` from text + role. The id is required by
 * AI SDK consumers; we use a 12-char base36 random suffix unless caller
 * provides one.
 */
export function makeTranscriptMessage(args: {
	role: 'user' | 'assistant' | 'system';
	text: string;
	userId?: string;
	id?: string;
	createdAt?: number;
}): TranscriptMessage {
	return {
		id: args.id ?? `msg_${Math.random().toString(36).slice(2, 14)}`,
		role: args.role,
		parts: [{ type: 'text', text: args.text }],
		createdAt: args.createdAt ?? Date.now(),
		...(args.userId !== undefined ? { userId: args.userId } : {}),
	};
}
