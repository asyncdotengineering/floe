/**
 * Mock-service lifecycle for the ops-bot template. Stands up Okta,
 * Notion, and Linear MCP servers backed by `@floe/mock-services` so
 * the template runs end-to-end with `pnpm dev` — no external API
 * accounts needed.
 *
 * To swap any mock for a real implementation:
 *   1. Replace the corresponding `mount<X>` call with a static config:
 *      `{ name: 'linear', url: process.env.LINEAR_MCP_URL!, headers: {...} }`
 *   2. Delete the mount from `mountAllMocks` so the mock isn't started.
 *   3. Ensure your real MCP server exposes the same operation names
 *      the assistant prompt expects (see AGENTS.md).
 */
import {
	mountOkta,
	mountNotion,
	mountLinear,
	type MockMcpHandle,
} from '@floe/mock-services';

export interface MountedMocks {
	okta: MockMcpHandle;
	notion: MockMcpHandle;
	linear: MockMcpHandle;
	stopAll(): Promise<void>;
}

export async function mountAllMocks(): Promise<MountedMocks> {
	const [okta, notion, linear] = await Promise.all([
		mountOkta({ port: Number(process.env.OPS_MOCK_OKTA_PORT ?? 4001) }),
		mountNotion({ port: Number(process.env.OPS_MOCK_NOTION_PORT ?? 4002) }),
		mountLinear({ port: Number(process.env.OPS_MOCK_LINEAR_PORT ?? 4003) }),
	]);
	console.log(`[ops-bot:mocks] okta   → ${okta.url}`);
	console.log(`[ops-bot:mocks] notion → ${notion.url}`);
	console.log(`[ops-bot:mocks] linear → ${linear.url}`);
	return {
		okta,
		notion,
		linear,
		async stopAll() {
			await Promise.allSettled([okta.stop(), notion.stop(), linear.stop()]);
		},
	};
}
