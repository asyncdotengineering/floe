/**
 * MCP server registry — process-scoped connection cache.
 *
 * Connecting to an MCP server is a multi-RTT handshake (transport open +
 * client.connect + listTools). Doing it per-turn adds 100-500ms to TTFT
 * for every conversation. We cache the connection at module scope, keyed
 * by `name+url+transport`, lazy-init on first use, and never disconnect
 * during process lifetime.
 *
 * Failure handling: if a server is unreachable, we cache the failure for
 * `retryAfterMs` (default 30s) so subsequent turns get the tools that DO
 * work without paying the failed-connect cost every turn. The MCP outage
 * never aborts the conversation — the agent just doesn't see those tools.
 */
import { connectMcpServer, type McpServerConnection, type ToolDef } from '@flue/runtime';
import type { McpServerConfig } from './types.ts';

interface CacheEntry {
	/** Resolved connection, or null if the most recent attempt failed. */
	connection: McpServerConnection | null;
	/** When to next attempt a reconnect for a failed entry. */
	retryAt: number;
	/** Most recent error message for diagnostics. */
	lastError?: string;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<void>>();

function cacheKey(config: McpServerConfig): string {
	const url = config.url instanceof URL ? config.url.href : String(config.url);
	return `${config.name}::${url}::${config.transport ?? 'streamable-http'}`;
}

async function ensureConnection(config: McpServerConfig): Promise<void> {
	const key = cacheKey(config);
	const existing = cache.get(key);
	const now = Date.now();

	if (existing?.connection) return;
	if (existing && now < existing.retryAt) return;

	let pending = inflight.get(key);
	if (pending) {
		await pending;
		return;
	}

	pending = (async () => {
		try {
			const connection = await connectMcpServer(config.name, {
				url: config.url,
				transport: config.transport,
				headers: config.headers,
			});
			cache.set(key, { connection, retryAt: 0 });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(
				`[floe/mcp] connect failed for "${config.name}" — falling back without its tools: ${message}`,
			);
			cache.set(key, {
				connection: null,
				retryAt: Date.now() + (config.retryAfterMs ?? 30_000),
				lastError: message,
			});
		} finally {
			inflight.delete(key);
		}
	})();

	inflight.set(key, pending);
	await pending;
}

/**
 * Collect MCP tools for the given server configs. Returns whatever
 * resolves successfully — failed servers are skipped (logged once,
 * cached as unavailable until retryAt).
 *
 * Duplicate server names across configs throw, since the cache key would
 * collide and the LLM would see conflicting `mcp__<name>__*` prefixes.
 */
export async function getMcpTools(configs: McpServerConfig[] | undefined): Promise<ToolDef[]> {
	if (!configs || configs.length === 0) return [];

	const seen = new Set<string>();
	for (const c of configs) {
		if (seen.has(c.name)) {
			throw new Error(`[floe/mcp] Duplicate MCP server name "${c.name}". Names must be unique.`);
		}
		seen.add(c.name);
	}

	await Promise.all(configs.map((c) => ensureConnection(c)));

	const tools: ToolDef[] = [];
	for (const config of configs) {
		const entry = cache.get(cacheKey(config));
		if (entry?.connection) tools.push(...entry.connection.tools);
	}
	return tools;
}

/** Diagnostic — return current cache state. Useful for telemetry/tests. */
export function getMcpStatus(): Array<{
	name: string;
	connected: boolean;
	toolCount: number;
	retryAt: number;
	lastError?: string;
}> {
	return [...cache.entries()].map(([key, entry]) => {
		const name = key.split('::')[0]!;
		return {
			name,
			connected: !!entry.connection,
			toolCount: entry.connection?.tools.length ?? 0,
			retryAt: entry.retryAt,
			lastError: entry.lastError,
		};
	});
}

/** Test helper — clear cache + close any open connections. */
export async function __resetMcpRegistryForTests(): Promise<void> {
	const connections = [...cache.values()].map((e) => e.connection).filter((c) => c !== null);
	cache.clear();
	inflight.clear();
	await Promise.allSettled(connections.map((c) => c!.close()));
}
