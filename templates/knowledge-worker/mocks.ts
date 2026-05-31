/**
 * Mock-service lifecycle for the knowledge-worker template.
 *
 * Four MCP servers, all mocked: Notion (docs), Linear (tickets),
 * Calendar (events), Email (inbox). Same swap-to-real pattern as the
 * other templates — replace any `mount<X>` call with a real MCP
 * server URL when you wire your actual tools.
 */
import {
	mountNotion,
	mountLinear,
	mountCalendar,
	mountEmail,
	type MockMcpHandle,
} from '@floe/mock-services';

export interface MountedMocks {
	notion: MockMcpHandle;
	linear: MockMcpHandle;
	calendar: MockMcpHandle;
	email: MockMcpHandle;
	stopAll(): Promise<void>;
}

export async function mountAllMocks(): Promise<MountedMocks> {
	const [notion, linear, calendar, email] = await Promise.all([
		mountNotion({ port: Number(process.env.KW_MOCK_NOTION_PORT ?? 4301) }),
		mountLinear({ port: Number(process.env.KW_MOCK_LINEAR_PORT ?? 4302) }),
		mountCalendar({ port: Number(process.env.KW_MOCK_CALENDAR_PORT ?? 4303) }),
		mountEmail({ port: Number(process.env.KW_MOCK_EMAIL_PORT ?? 4304) }),
	]);
	console.log(`[knowledge-worker:mocks] notion   → ${notion.url}`);
	console.log(`[knowledge-worker:mocks] linear   → ${linear.url}`);
	console.log(`[knowledge-worker:mocks] calendar → ${calendar.url}`);
	console.log(`[knowledge-worker:mocks] email    → ${email.url}`);
	return {
		notion,
		linear,
		calendar,
		email,
		async stopAll() {
			await Promise.allSettled([notion.stop(), linear.stop(), calendar.stop(), email.stop()]);
		},
	};
}
