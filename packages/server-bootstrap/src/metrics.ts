/**
 * Bench-side stream metrics observer.
 *
 * Wraps every JSON response with `result.stream = {ttftMs, endToEndMs,
 * deltaCount, deltaBytes, streamingObserved}` populated from real
 * `text_delta` event timings. The bench harness asserts against this
 * shape (real TTFT < server end-to-end, deltas > 0, etc).
 *
 * Production servers should NOT use this — they should emit to a real
 * observability sink instead. This exists purely for the bench harness's
 * HTTP-level contract. It used to be 60 LOC copy-pasted across three
 * example server.ts files.
 */
import { observe } from '@floe/runtime';

interface RunMetrics {
	startedAt: number;
	firstDeltaAt?: number;
	endedAt?: number;
	deltaCount: number;
	deltaBytes: number;
}

let installed = false;
const metricsByRun = new Map<string, RunMetrics>();

function installObserverOnce(): void {
	if (installed) return;
	installed = true;
	observe((event, ctx) => {
		const runId = ctx.runId;
		switch (event.type) {
			case 'run_start':
				metricsByRun.set(runId, {
					startedAt: Date.now(),
					deltaCount: 0,
					deltaBytes: 0,
				});
				return;
			case 'text_delta': {
				const rec = metricsByRun.get(runId);
				if (!rec) return;
				rec.deltaCount += 1;
				rec.deltaBytes += event.text.length;
				if (rec.firstDeltaAt === undefined) {
					rec.firstDeltaAt = Date.now();
				}
				return;
			}
			case 'run_end': {
				const rec = metricsByRun.get(runId);
				if (rec) rec.endedAt = Date.now();
				return;
			}
		}
	});
}

/**
 * Wrap a `fetch`-shaped handler so JSON responses carry a `result.stream`
 * field. Non-JSON responses (SSE streams) pass through untouched.
 */
export function wrapWithMetrics(
	inner: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
	installObserverOnce();
	return async (req: Request): Promise<Response> => {
		const response = await inner(req);
		const ct = response.headers.get('content-type') ?? '';
		if (!ct.includes('application/json')) return response;
		const runId = response.headers.get('x-flue-run-id') ?? undefined;
		if (!runId) return response;
		const rec = metricsByRun.get(runId);
		metricsByRun.delete(runId);
		if (!rec) return response;
		const body = (await response.clone().json()) as {
			result?: Record<string, unknown>;
		};
		const enriched = {
			...body,
			result: {
				...body.result,
				stream: {
					ttftMs: rec.firstDeltaAt ? rec.firstDeltaAt - rec.startedAt : null,
					endToEndMs: (rec.endedAt ?? Date.now()) - rec.startedAt,
					deltaCount: rec.deltaCount,
					deltaBytes: rec.deltaBytes,
					streamingObserved: rec.deltaCount > 0,
				},
			},
		};
		const headers = new Headers(response.headers);
		headers.set('content-type', 'application/json');
		return new Response(JSON.stringify(enriched), {
			status: response.status,
			headers,
		});
	};
}
