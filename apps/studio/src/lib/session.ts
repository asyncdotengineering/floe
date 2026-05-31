/**
 * Per-browser session-id management.
 *
 * We mint a stable id and persist it in `localStorage` so a page
 * refresh resumes the SAME Floe conversation. The id is sent in the
 * `user` field of the openai-compat request body; Floe derives the
 * sessionId from it (see `packages/runtime/src/openai-compat/handler.ts`
 * `deriveSessionId` → `oai:${user}`).
 *
 * To start a fresh conversation: call `resetSession()` and reload.
 */
const SESSION_STORAGE_KEY = 'floe-studio:session-id';

function uuid(): string {
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
		return crypto.randomUUID();
	}
	return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function getOrCreateSessionId(): string {
	if (typeof window === 'undefined') return 'ssr-placeholder';
	const stored = window.localStorage.getItem(SESSION_STORAGE_KEY);
	if (stored) return stored;
	const fresh = `studio-${uuid()}`;
	window.localStorage.setItem(SESSION_STORAGE_KEY, fresh);
	return fresh;
}

export function resetSession(): string {
	if (typeof window === 'undefined') return 'ssr-placeholder';
	const fresh = `studio-${uuid()}`;
	window.localStorage.setItem(SESSION_STORAGE_KEY, fresh);
	return fresh;
}
