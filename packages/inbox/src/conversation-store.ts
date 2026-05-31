/**
 * ConversationStore — single aggregate replacing the three scattered
 * persistence primitives (AssistantStateStore, TranscriptStore,
 * and parts of SessionStore).
 *
 * Every method takes `tenantId` first — tenancy is the partition
 * primitive. One interface, one owner. Implementations (in-memory,
 * Turso, Postgres) encapsulate their own table layout.
 *
 * Per REFACTOR-FIN-HARNESS §4.5.
 */

import type { Conversation } from './conversation.ts';
import type { TenantId } from './identity.ts';
import type { Turn } from './turn.ts';

// ─── Query types ──────────────────────────────────────────────────────────

export interface ConversationQuery {
	status?: string;
	limit?: number;
	offset?: number;
}

export interface TurnQuery {
	limit?: number;
	offset?: number;
	after?: number; // only turns started after this timestamp (ms)
}

export interface TimeRange {
	start: number;
	end: number;
}

export interface OutcomesRollup {
	totalConversations: number;
	totalTurns: number;
	resolved: number;
	escalated: number;
	refused: number;
	toolError: number;
}

// ─── Store interface ──────────────────────────────────────────────────────

export interface ConversationStore {
	upsertConversation(c: Conversation): Promise<void>;
	getConversation(tenantId: TenantId, id: string): Promise<Conversation | null>;
	listConversations(
		tenantId: TenantId,
		q: ConversationQuery,
	): Promise<Conversation[]>;

	appendTurn(turn: Turn): Promise<void>;
	getTurns(
		tenantId: TenantId,
		conversationId: string,
		q?: TurnQuery,
	): Promise<Turn[]>;

	outcomesRollup(
		tenantId: TenantId,
		range: TimeRange,
	): Promise<OutcomesRollup>;
}

// ─── In-memory implementation ─────────────────────────────────────────────

const EMPTY_ROLLUP: OutcomesRollup = {
	totalConversations: 0,
	totalTurns: 0,
	resolved: 0,
	escalated: 0,
	refused: 0,
	toolError: 0,
};

export class InMemoryConversationStore implements ConversationStore {
	private readonly convs = new Map<string, Conversation>();
	private readonly turns = new Map<string, Turn[]>();

	private convKey(tenantId: TenantId, id: string): string {
		return `${tenantId}::${id}`;
	}

	async upsertConversation(c: Conversation): Promise<void> {
		this.convs.set(this.convKey(c.tenantId, c.id), c);
	}

	async getConversation(
		tenantId: TenantId,
		id: string,
	): Promise<Conversation | null> {
		return this.convs.get(this.convKey(tenantId, id)) ?? null;
	}

	async listConversations(
		tenantId: TenantId,
		q: ConversationQuery,
	): Promise<Conversation[]> {
		const prefix = `${tenantId}::`;
		let results: Conversation[] = [];
		for (const [key, c] of this.convs) {
			if (!key.startsWith(prefix)) continue;
			if (q.status && c.status !== q.status) continue;
			results.push(c);
		}
		results.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
		if (q.offset) results = results.slice(q.offset);
		if (q.limit) results = results.slice(0, q.limit);
		return results;
	}

	async appendTurn(turn: Turn): Promise<void> {
		const key = this.convKey(turn.tenantId, turn.conversationId);
		const list = this.turns.get(key) ?? [];
		list.push(turn);
		this.turns.set(key, list);
	}

	async getTurns(
		tenantId: TenantId,
		conversationId: string,
		q?: TurnQuery,
	): Promise<Turn[]> {
		const key = this.convKey(tenantId, conversationId);
		const all = this.turns.get(key) ?? [];
		let results: Turn[] = all;
		if (q?.after !== undefined) {
			results = results.filter((t) => t.startedAt > q.after!);
		}
		results.sort((a, b) => a.startedAt - b.startedAt);
		if (q?.offset) results = results.slice(q.offset);
		if (q?.limit) results = results.slice(0, q.limit);
		return results;
	}

	async outcomesRollup(
		tenantId: TenantId,
		range: TimeRange,
	): Promise<OutcomesRollup> {
		const prefix = `${tenantId}::`;
		const rollup: OutcomesRollup = { ...EMPTY_ROLLUP };
		const convSeen = new Set<string>();
		for (const [key, list] of this.turns) {
			if (!key.startsWith(prefix)) continue;
			for (const t of list) {
				if (t.startedAt < range.start || t.startedAt >= range.end)
					continue;
				if (t.outcome.type === 'in_progress') continue;
				rollup.totalTurns += 1;
				convSeen.add(key);
				switch (t.outcome.type) {
					case 'answered':
						rollup.resolved += 1;
						break;
					case 'handed_off':
						rollup.escalated += 1;
						break;
					case 'refused':
						rollup.refused += 1;
						break;
					case 'tool_error':
						rollup.toolError += 1;
						break;
				}
			}
		}
		rollup.totalConversations = convSeen.size;
		return rollup;
	}
}
