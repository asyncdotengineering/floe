/**
 * In-memory resumable-stream registry.
 *
 * Lets a client reconnect after a dropped connection and resume the
 * in-flight stream from the beginning (chunks are buffered until the
 * stream completes + 5min GC window).
 *
 * Pattern adapted from Vercel's `resumable-stream` package — which
 * requires Redis pubsub for serverless / multi-replica deployments.
 * This in-memory version is deliberately scoped to single-process
 * dev/prod. To upgrade:
 *
 *   pnpm add resumable-stream redis
 *   // Then swap this file's `registerStream` / `resumeStream` for
 *   // `streamContext.createNewResumableStream(id, () => stream)` /
 *   // `streamContext.resumeExistingStream(id, resumeAt)` from
 *   // `createResumableStreamContext({waitUntil})`.
 *
 * The swap is API-compatible at the route-handler level. See
 * apps/studio/src/routes/api/chat.ts + stream.$streamId.ts for the
 * exact integration shape.
 */

interface RegistryEntry {
	chunks: Uint8Array[];
	done: boolean;
	error: Error | null;
	subscribers: Set<{
		write: (chunk: Uint8Array) => void;
		close: () => void;
	}>;
}

const registry = new Map<string, RegistryEntry>();
const GC_AFTER_MS = 5 * 60_000;

/**
 * Pipe a source stream through the registry. The returned stream
 * mirrors the source for the original client; the registry also
 * buffers every chunk so a resumer can replay later.
 */
export function registerStream(
	id: string,
	source: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
	const entry: RegistryEntry = {
		chunks: [],
		done: false,
		error: null,
		subscribers: new Set(),
	};
	registry.set(id, entry);

	const [forClient, forBuffer] = source.tee();
	void drain(id, entry, forBuffer);
	return forClient;
}

async function drain(
	id: string,
	entry: RegistryEntry,
	source: ReadableStream<Uint8Array>,
): Promise<void> {
	const reader = source.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			entry.chunks.push(value);
			for (const sub of entry.subscribers) {
				try {
					sub.write(value);
				} catch {
					entry.subscribers.delete(sub);
				}
			}
		}
	} catch (err) {
		entry.error = err instanceof Error ? err : new Error(String(err));
	} finally {
		entry.done = true;
		for (const sub of entry.subscribers) {
			try {
				sub.close();
			} catch {
				// no-op
			}
		}
		entry.subscribers.clear();
		// Hold the buffer around long enough for late resumers to
		// replay it on a refresh, then GC.
		setTimeout(() => registry.delete(id), GC_AFTER_MS);
	}
}

/**
 * Resume an in-flight or recently-completed stream. Returns null if
 * the stream is unknown (or GC'd). Replays buffered chunks then
 * continues live if the stream is still running.
 */
export function resumeStream(id: string): ReadableStream<Uint8Array> | null {
	const entry = registry.get(id);
	if (!entry) return null;

	return new ReadableStream<Uint8Array>({
		start(controller) {
			// Replay everything buffered so far.
			for (const chunk of entry.chunks) controller.enqueue(chunk);
			if (entry.done) {
				if (entry.error) controller.error(entry.error);
				else controller.close();
				return;
			}
			// Subscribe for future chunks.
			const sub = {
				write: (chunk: Uint8Array) => controller.enqueue(chunk),
				close: () => controller.close(),
			};
			entry.subscribers.add(sub);
		},
	});
}

/** Test/debug helper — current size of the registry. */
export function registrySize(): number {
	return registry.size;
}
