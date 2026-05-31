/**
 * MCP (Model Context Protocol) server configuration.
 *
 * Lets Floe agents reach external tool servers — GitHub, Linear, Slack,
 * Notion, a private internal MCP — via Flue's `connectMcpServer`. Tools
 * appear to the LLM as `mcp__<server>__<tool>`.
 */
import type { McpTransport } from '@flue/runtime';

export interface McpServerConfig {
	/**
	 * Stable identifier for the server. Used as the cache key and as the
	 * tool-name prefix exposed to the LLM. Two servers with the same name
	 * are an error.
	 */
	name: string;
	url: string | URL;
	/** Defaults to 'streamable-http'. Use 'sse' for legacy MCP servers. */
	transport?: McpTransport;
	/**
	 * Request headers sent on every MCP call (usually auth bearer token).
	 * Use `connectMcpServer` directly if you need richer `HeadersInit` shapes.
	 */
	headers?: Record<string, string>;
	/**
	 * Connection retry policy after a failed connect. The registry caches
	 * the failure for `retryAfterMs` so a flaky server doesn't burn the
	 * connect handshake on every turn. Default: 30000.
	 */
	retryAfterMs?: number;
}

export type McpDefaults = McpServerConfig[];
