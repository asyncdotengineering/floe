/**
 * Turso-backed SessionStore.
 *
 * Implements Flue's `SessionStore` { save, load, delete } against libSQL.
 * Session payload (the whole `SessionData` JSON — version, entries,
 * metadata) is serialized into a single TEXT column. The orchestrator
 * writes once per turn (after the agent loop returns).
 *
 * Lazy-`ensureTable` pattern (per the render-examples flue-postgres
 * template): the table-create promise is memoized after first success;
 * if the create errors, the memo is cleared so the next call retries.
 * No cold-start migration ceremony — just call save/load/delete.
 */
import { createClient, type Client } from '@libsql/client';
import type { SessionStore } from '@floe/runtime';

export interface LibsqlSessionStoreOpts {
	url: string;
	authToken?: string;
	/** Override the table name. Defaults to `flue_sessions`. */
	table?: string;
}

export function libsqlSessionStore(opts: LibsqlSessionStoreOpts): SessionStore {
	const table = opts.table ?? 'flue_sessions';
	const db: Client = createClient({ url: opts.url, authToken: opts.authToken });
	let ready: Promise<void> | undefined;
	const ensureTable = (): Promise<void> => {
		ready ??= db
			.execute(
				`CREATE TABLE IF NOT EXISTS ${table} (
					id TEXT PRIMARY KEY,
					data TEXT NOT NULL,
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
		async load(id) {
			await ensureTable();
			const result = await db.execute({
				sql: `SELECT data FROM ${table} WHERE id = ?`,
				args: [id],
			});
			const row = result.rows[0];
			if (!row) return null;
			const raw = row.data;
			if (typeof raw !== 'string') return null;
			try {
				return JSON.parse(raw);
			} catch {
				// Corrupt row — treat as missing rather than crash the agent.
				return null;
			}
		},
		async save(id, data) {
			await ensureTable();
			await db.execute({
				sql: `INSERT INTO ${table} (id, data, updated_at) VALUES (?, ?, ?)
					ON CONFLICT(id) DO UPDATE SET
						data = excluded.data,
						updated_at = excluded.updated_at`,
				args: [id, JSON.stringify(data), Date.now()],
			});
		},
		async delete(id) {
			await ensureTable();
			await db.execute({
				sql: `DELETE FROM ${table} WHERE id = ?`,
				args: [id],
			});
		},
	};
}
