/**
 * Mount one or more `MockService`s as a Streamable HTTP MCP server.
 * The returned handle is `McpServerConfig`-shaped, so templates can
 * drop it straight into `Assistant({ mcpServers: [...] })`.
 *
 * Hides: JSON-RPC plumbing (`Server` + `StreamableHTTPServerTransport`),
 * `ListTools` + `CallTool` request handlers, content-array framing,
 * valibot → JSON Schema conversion (we ship a small subset; users with
 * complex schemas pass an `inputSchema` override on the operation),
 * and Node `createServer` boilerplate.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as v from 'valibot';
import type { MockService } from './define-mock-service.ts';
import { valibotToJsonSchema } from './jsonschema.ts';

export interface MountMockMcpOptions {
	/** TCP port to bind. */
	port: number;
	/** HTTP path the MCP transport listens on. Default `/mcp`. */
	path?: string;
	/**
	 * Simulate network latency on every operation. Default `0`.
	 * Useful for matching real-API characteristics in dev/bench.
	 */
	latencyMs?: number;
	/**
	 * Simulate transient failures (0..1). Each operation has this
	 * probability of throwing a "transient failure" error before the
	 * handler runs. Default `0`.
	 */
	failRate?: number;
	/** Override the MCP server's reported name. Default = service.name. */
	displayName?: string;
}

export interface MockMcpHandle {
	/** The MCP server name (matches `McpServerConfig.name`). */
	name: string;
	/** Full URL including the transport path. */
	url: string;
	port: number;
	stop(): Promise<void>;
	/** Reset every backing service's store. */
	reset(): void;
}

export async function mountMockMcp(
	services: MockService[] | MockService,
	opts: MountMockMcpOptions,
): Promise<MockMcpHandle> {
	const svcs = Array.isArray(services) ? services : [services];
	if (svcs.length === 0) throw new Error('[mount-mock-mcp] no services provided');
	const primary = svcs[0]!;
	const displayName = opts.displayName ?? primary.name;
	const path = opts.path ?? '/mcp';
	const latency = opts.latencyMs ?? 0;
	const failRate = opts.failRate ?? 0;

	// Build the tool table once: keys are `${service}__${op}` when
	// multiple services share one server; single-service mounts use
	// the bare op name (preserves the simpler tool naming).
	type ToolEntry = {
		mcpName: string;
		description: string;
		inputSchema: ReturnType<typeof valibotToJsonSchema>;
		invoke: (args: unknown) => Promise<unknown>;
	};
	const tools: ToolEntry[] = [];
	for (const svc of svcs) {
		const prefix = svcs.length > 1 ? `${svc.name}__` : '';
		for (const op of svc.operations) {
			tools.push({
				mcpName: `${prefix}${op.name}`,
				description: op.description,
				inputSchema: valibotToJsonSchema(op.input as v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>),
				invoke: op.invoke,
			});
		}
	}

	const mcp = new McpServer(
		{ name: displayName, version: '0.1.0' },
		{ capabilities: { tools: {} } },
	);
	mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.map((t) => ({
			name: t.mcpName,
			description: t.description,
			inputSchema: t.inputSchema,
		})),
	}));
	mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
		const tool = tools.find((t) => t.mcpName === req.params.name);
		if (!tool) {
			return {
				isError: true,
				content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
			};
		}
		if (latency > 0) await new Promise((r) => setTimeout(r, latency));
		if (failRate > 0 && Math.random() < failRate) {
			return {
				isError: true,
				content: [{ type: 'text', text: '[mock-services] simulated transient failure' }],
			};
		}
		try {
			const result = await tool.invoke(req.params.arguments ?? {});
			const text = typeof result === 'string' ? result : JSON.stringify(result);
			return { content: [{ type: 'text', text }] };
		} catch (err) {
			return {
				isError: true,
				content: [
					{ type: 'text', text: err instanceof Error ? err.message : String(err) },
				],
			};
		}
	});

	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: () => crypto.randomUUID(),
	});
	await mcp.connect(transport);

	const http: HttpServer = createServer(async (req, res) => {
		if (!req.url?.startsWith(path)) {
			res.writeHead(404).end('not found');
			return;
		}
		await transport.handleRequest(req, res);
	});

	await new Promise<void>((resolve, reject) => {
		http.once('error', reject);
		http.listen(opts.port, () => {
			http.off('error', reject);
			resolve();
		});
	});

	const url = `http://localhost:${opts.port}${path}`;

	return {
		name: displayName,
		url,
		port: opts.port,
		async stop() {
			await new Promise<void>((resolve) => http.close(() => resolve()));
		},
		reset() {
			for (const svc of svcs) svc.reset();
		},
	};
}
