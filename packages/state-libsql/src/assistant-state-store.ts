/**
 * Turso-backed AssistantStateStore. One JSON column keyed by sessionId.
 * Same lazy-`ensureTable` pattern as turso-session-store.ts.
 */
import { createClient, type Client } from '@libsql/client';
import type { AssistantStateStore } from '@floe/runtime';
import type { AssistantState } from '@floe/runtime';

export interface LibsqlAssistantStateStoreOpts {
	url: string;
	authToken?: string;
	/** Override the table name. Defaults to `floe_conversation_state`. */
	table?: string;
}

export function libsqlAssistantStateStore(
	opts: LibsqlAssistantStateStoreOpts,
): AssistantStateStore {
	const table = opts.table ?? 'floe_conversation_state';
	const db: Client = createClient({ url: opts.url, authToken: opts.authToken });
	let ready: Promise<void> | undefined;
	const ensureTable = (): Promise<void> => {
		ready ??= db
			.execute(
				`CREATE TABLE IF NOT EXISTS ${table} (
					session_id TEXT PRIMARY KEY,
					state TEXT NOT NULL,
					updated_at INTEGER NOT NULL
				)`,
			)
			.then(() => undefined)
			.catch((err: unknown) => {
				ready = undefined;
				throw err;
			});
		return ready;
	};

	return {
		async load(sessionId): Promise<AssistantState | null> {
			await ensureTable();
			const r = await db.execute({
				sql: `SELECT state FROM ${table} WHERE session_id = ?`,
				args: [sessionId],
			});
			const row = r.rows[0];
			if (!row || typeof row.state !== 'string') return null;
			try {
				return JSON.parse(row.state) as AssistantState;
			} catch {
				return null;
			}
		},
		async save(sessionId, state) {
			await ensureTable();
			await db.execute({
				sql: `INSERT INTO ${table} (session_id, state, updated_at) VALUES (?, ?, ?)
					ON CONFLICT(session_id) DO UPDATE SET
						state = excluded.state,
						updated_at = excluded.updated_at`,
				args: [sessionId, JSON.stringify(state), Date.now()],
			});
		},
	};
}
