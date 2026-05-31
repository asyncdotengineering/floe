/**
 * GET /api/stream/:streamId — resume an in-flight (or recently-
 * completed) chat stream that was registered by POST /api/chat.
 *
 * The client stashes the `x-resume-stream-id` returned by /api/chat;
 * on page refresh, if a stream is still in flight, it hits this route
 * to replay buffered chunks and continue receiving live ones.
 *
 * 404 = stream unknown or GC'd (5min window).
 */
import { createFileRoute } from '@tanstack/react-router';
import { resumeStream } from '~/lib/stream-registry';

export const Route = createFileRoute('/api/stream/$streamId')({
	server: {
		handlers: {
			GET: async ({ params }: { params: { streamId: string } }) => {
				const { streamId } = params;
				const stream = resumeStream(streamId);
				if (!stream) {
					return new Response(JSON.stringify({ error: 'stream_not_found' }), {
						status: 404,
						headers: { 'content-type': 'application/json' },
					});
				}
				return new Response(stream, {
					status: 200,
					headers: {
						'content-type': 'text/event-stream',
						'cache-control': 'no-cache, no-transform',
						connection: 'keep-alive',
						'x-accel-buffering': 'no',
					},
				});
			},
		},
	},
});
