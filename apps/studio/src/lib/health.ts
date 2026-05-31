/**
 * Liveness probe against a Floe agent URL — runs SERVER-SIDE.
 *
 * The browser-side fetch used to hit the agent URL directly, which
 * works for same-origin localhost but breaks the moment the agent is
 * on a different origin (cloudflared tunnel, fly.io, prod URL) because
 * the agent doesn't answer CORS preflight. Routing through
 * /api/health?url=... bypasses CORS — the chat proxy goes through the
 * server too, so this matches the actual connectivity the chat sees.
 */
export interface HealthResult {
	ok: boolean;
	status?: number;
	durationMs: number;
	error?: string;
}

export async function checkAgentHealth(url: string, timeoutMs = 6000): Promise<HealthResult> {
	const start = performance.now();
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), timeoutMs);
	try {
		const res = await fetch(`/api/health?url=${encodeURIComponent(url)}`, {
			method: 'GET',
			signal: ctl.signal,
		});
		clearTimeout(timer);
		const body = (await res.json()) as HealthResult;
		// Override durationMs with our browser-perceived latency, since
		// that's what the user actually feels.
		return { ...body, durationMs: Math.round(performance.now() - start) };
	} catch (err) {
		clearTimeout(timer);
		return {
			ok: false,
			durationMs: Math.round(performance.now() - start),
			error: err instanceof Error ? err.message : 'unknown',
		};
	}
}
