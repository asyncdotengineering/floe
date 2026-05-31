/**
 * MCP example — the Assistant reaches an external tool server via
 * Model Context Protocol. Tools appear to the LLM as
 * `mcp__<server-name>__<tool-name>` and are called transparently.
 *
 * Pair with `node mcp-stub-server.ts` (running on port 3201) to test
 * locally. Replace the URL with any production MCP server (GitHub,
 * Linear, Slack, Notion) to point at the real thing.
 */
import { Assistant } from '@floe/runtime';
import { localSandbox } from '@floe/runtime/sandbox/local';

export const inventory = new Assistant({
	name: 'inventory',
	mode: 'direct',
	systemPrompt: `You are an inventory assistant. When a user asks about stock, availability, or a product SKU, use the inventory tools (prefixed with mcp__inventory__) to look up real data. Never guess. If a tool is unavailable, say so honestly.`,
	model: process.env.FLOE_MODEL ?? 'openai/gpt-4.1-mini',
	thinkingLevel: 'off',
	sandbox: localSandbox(),
	mcp: [
		{
			name: 'inventory',
			url: process.env.MCP_INVENTORY_URL ?? 'http://localhost:3201/mcp',
		},
	],
});

export default inventory;
