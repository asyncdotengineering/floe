/**
 * Turso-backed TranscriptStore. Schema:
 *
 *   transcript_messages(
 *     session_id TEXT, turn_index INTEGER,
 *     message TEXT,  -- JSON-encoded TranscriptMessage
 *     user_id TEXT, created_at INTEGER,
 *     PRIMARY KEY (session_id, turn_index)
 *   )
 *
 * `listSessions(userId)` reads the latest message per session for that
 * user via a window query — cheap because we index (user_id, created_at).
 */
import { createClient, type Client } from '@libsql/client';
import type {
	TranscriptListResult,
	TranscriptListSessionsResult,
	TranscriptMessage,
	TranscriptStore,
} from '@floe/runtime';

export interface LibsqlTranscriptStoreOpts {
	url: string;
	authToken?: string;
	/** Override the table name. Defaults to `floe_transcript`. */
	table?: string;
}

export function libsqlTranscriptStore(opts: LibsqlTranscriptStoreOpts): TranscriptStore {
	const table = opts.table ?? 'floe_transcript';
	const db: Client = createClient({ url: opts.url, authToken: opts.authToken });
	let ready: Promise<void> | undefined;
	const ensureTable = (): Promise<void> => {
		ready ??= (async () => {
			await db.execute(
				`CREATE TABLE IF NOT EXISTS ${table} (
					session_id TEXT NOT NULL,
					turn_index INTEGER NOT NULL,
					message TEXT NOT NULL,
					user_id TEXT,
					created_at INTEGER NOT NULL,
					PRIMARY KEY (session_id, turn_index)
				)`,
			);
			await db.execute(
				`CREATE INDEX IF NOT EXISTS idx_${table}_user_time
				 ON ${table}(user_id, created_at DESC)`,
			);
		})().catch((err: unknown) => {
			ready = undefined;
			throw err;
		});
		return ready;
	};

	return {
		async append(sessionId, message: TranscriptMessage): Promise<void> {
			await ensureTable();
			// next turn_index = current count for this session
			const r = await db.execute({
				sql: `SELECT COALESCE(MAX(turn_index), -1) + 1 AS next FROM ${table} WHERE session_id = ?`,
				args: [sessionId],
			});
			const next = Number(r.rows[0]?.next ?? 0);
			await db.execute({
				sql: `INSERT INTO ${table} (session_id, turn_index, message, user_id, created_at)
				      VALUES (?, ?, ?, ?, ?)`,
				args: [
					sessionId,
					next,
					JSON.stringify(message),
					message.userId ?? null,
					message.createdAt,
				],
			});
		},

		async list(sessionId, options = {}): Promise<TranscriptListResult> {
			await ensureTable();
			const limit = Math.max(1, Math.min(500, options.limit ?? 100));
			const cursor = options.cursor ? Number.parseInt(options.cursor, 10) || 0 : 0;
			const r = await db.execute({
				sql: `SELECT message, turn_index FROM ${table}
				      WHERE session_id = ? AND turn_index >= ?
				      ORDER BY turn_index ASC LIMIT ?`,
				args: [sessionId, cursor, limit + 1],
			});
			const rows = r.rows;
			const hasMore = rows.length > limit;
			const taken = hasMore ? rows.slice(0, limit) : rows;
			const messages: TranscriptMessage[] = taken
				.map((row) => {
					if (typeof row.message !== 'string') return null;
					try {
						return JSON.parse(row.message) as TranscriptMessage;
					} catch {
						return null;
					}
				})
				.filter((m): m is TranscriptMessage => m !== null);
			const lastIdx = taken[taken.length - 1]?.turn_index;
			return {
				messages,
				nextCursor: hasMore && typeof lastIdx === 'number' ? String(lastIdx + 1) : null,
			};
		},

		async listSessions(userId, options = {}): Promise<TranscriptListSessionsResult> {
			await ensureTable();
			const limit = Math.max(1, Math.min(200, options.limit ?? 50));
			// Per session: max(created_at), count(*), and the first message text for preview.
			const r = await db.execute({
				sql: `WITH sessions AS (
					SELECT session_id,
					       MAX(created_at) AS last_at,
					       COUNT(*) AS turn_count
					FROM ${table}
					WHERE user_id = ?
					GROUP BY session_id
				)
				SELECT s.session_id, s.last_at, s.turn_count,
				       (SELECT message FROM ${table}
				        WHERE session_id = s.session_id
				        ORDER BY turn_index ASC LIMIT 1) AS first_msg
				FROM sessions s
				ORDER BY s.last_at DESC
				LIMIT ?`,
				args: [userId, limit],
			});
			const sessions = r.rows
				.map((row) => {
					const sessionId =
						typeof row.session_id === 'string' ? row.session_id : null;
					if (!sessionId) return null;
					const lastTurnAt = Number(row.last_at ?? 0);
					const turnCount = Number(row.turn_count ?? 0);
					let preview = '';
					if (typeof row.first_msg === 'string') {
						try {
							const m = JSON.parse(row.first_msg) as TranscriptMessage;
							preview = m.parts?.[0]?.type === 'text' ? m.parts[0].text.slice(0, 80) : '';
						} catch {
							/* ignore */
						}
					}
					return { sessionId, lastTurnAt, turnCount, preview, userId };
				})
				.filter((s): s is NonNullable<typeof s> => s !== null);
			return { sessions };
		},

		async delete(sessionId) {
			await ensureTable();
			await db.execute({
				sql: `DELETE FROM ${table} WHERE session_id = ?`,
				args: [sessionId],
			});
		},
	};
}
