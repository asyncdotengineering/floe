/**
 * Per-browser agent URL — overrides the server-side FLOE_AGENT_URL
 * env var when set. Persisted in localStorage.
 *
 * Flow:
 *   - Boot: read from localStorage; fall back to VITE_AGENT_URL build-time
 *     constant; fall back to localhost:3110.
 *   - Settings dialog: writes here.
 *   - Chat transport: sends in /api/chat body as `agentUrl`.
 *   - Server proxy: prefers `agentUrl` from body, then env, then default.
 */
const STORAGE_KEY = 'floe-studio:agent-url';
const DEFAULT_URL = 'http://localhost:3110';

export function getAgentUrl(): string {
	if (typeof window === 'undefined') return DEFAULT_URL;
	const stored = window.localStorage.getItem(STORAGE_KEY);
	if (stored && stored.trim()) return stored.trim();
	const buildTime = import.meta.env.VITE_AGENT_URL as string | undefined;
	return buildTime ?? DEFAULT_URL;
}

export function setAgentUrl(url: string): void {
	if (typeof window === 'undefined') return;
	const trimmed = url.trim().replace(/\/$/, '');
	if (trimmed) {
		window.localStorage.setItem(STORAGE_KEY, trimmed);
	} else {
		window.localStorage.removeItem(STORAGE_KEY);
	}
	// Tell any subscribers (status indicators etc) that URL changed.
	window.dispatchEvent(new CustomEvent('floe-studio:agent-url-changed', { detail: { url: trimmed } }));
}

export function clearAgentUrl(): void {
	if (typeof window === 'undefined') return;
	window.localStorage.removeItem(STORAGE_KEY);
	window.dispatchEvent(new CustomEvent('floe-studio:agent-url-changed', { detail: { url: getAgentUrl() } }));
}

export function isValidAgentUrl(url: string): boolean {
	try {
		const u = new URL(url);
		return u.protocol === 'http:' || u.protocol === 'https:';
	} catch {
		return false;
	}
}
