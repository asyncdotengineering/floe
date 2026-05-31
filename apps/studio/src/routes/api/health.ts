/**
 * GET /api/health?url=<agentUrl> — server-side health probe of the
 * configured Floe agent.
 *
 * Why server-side? The connection-status dot used to fetch the agent
 * URL directly from the browser, which works fine for same-origin
 * (everything on localhost) but breaks the moment the agent is on a
 * different origin (cloudflared tunnel, fly.io deploy, prod URL) —
 * the browser CORS-preflights GET /, the agent doesn't answer the
 * preflight, the dot stays red even though the chat works (because
 * the chat proxy is server-side and bypasses CORS entirely).
 *
 * Moving the probe here makes the dot accurate against any reachable
 * agent regardless of CORS posture.
 */
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/health')({
	server: {
		handlers: {
			GET: async ({ request }: { request: Request }) => {
				const url = new URL(request.url).searchParams.get('url');
				if (!url) {
					return jsonResponse({ ok: false, error: 'url query param required' }, 400);
				}
				let parsed: URL;
				try {
					parsed = new URL(url);
				} catch {
					return jsonResponse({ ok: false, error: 'invalid url' }, 400);
				}
				const ctl = new AbortController();
				const timer = setTimeout(() => ctl.abort(), 5000);
				const start = Date.now();
				try {
					const res = await fetch(parsed.toString().replace(/\/$/, '') + '/', {
						method: 'GET',
						signal: ctl.signal,
					});
					clearTimeout(timer);
					return jsonResponse({
						ok: true,
						status: res.status,
						durationMs: Date.now() - start,
					});
				} catch (err) {
					clearTimeout(timer);
					return jsonResponse({
						ok: false,
						error: err instanceof Error ? err.message : 'unknown',
						durationMs: Date.now() - start,
					});
				}
			},
		},
	},
});

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
}
