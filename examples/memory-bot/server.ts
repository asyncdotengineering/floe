/**
 * Node server for memory-bot. Adds a /__debug/memory/dump route the
 * live test uses to assert that memories actually persisted.
 *
 * Production memory inspection would go through @floe/runtime/observability
 * sinks or a real admin UI; this debug route exists purely for the test.
 */
import { runServer } from '@floe/server-bootstrap';
import concierge, { memoryService } from './floe.config.ts';

const debugDumpMemory = async (req: Request): Promise<Response> => {
	const body = (await req.json().catch(() => ({}))) as { userId?: string };
	if (!body.userId) {
		return new Response(JSON.stringify({ error: 'missing userId' }), {
			status: 400,
		});
	}
	const memories = await memoryService.search({
		userId: body.userId,
		query: 'preference contact email phone name like prefer',
		limit: 100,
	});
	return new Response(JSON.stringify({ result: { dump: memories } }), {
		headers: { 'content-type': 'application/json' },
	});
};

await runServer(concierge, {
	routes: { '/__debug/memory/dump': debugDumpMemory },
});
