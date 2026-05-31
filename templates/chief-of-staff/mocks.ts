/**
 * Mock-service lifecycle for the chief-of-staff template. Four bundled
 * mocks + one inline custom (Commitments). Demonstrates both
 * `mount<Domain>` one-liners and `defineMockService` + `mountMockMcp`
 * for off-catalog domains.
 */
import {
	mountNotion,
	mountLinear,
	mountCalendar,
	mountEmail,
	type MockMcpHandle,
} from '@floe/mock-services';
import { mountCommitments } from './commitments-mcp.ts';

export interface MountedMocks {
	notion: MockMcpHandle;
	linear: MockMcpHandle;
	calendar: MockMcpHandle;
	email: MockMcpHandle;
	commitments: MockMcpHandle;
	stopAll(): Promise<void>;
}

export async function mountAllMocks(): Promise<MountedMocks> {
	const [notion, linear, calendar, email, commitments] = await Promise.all([
		mountNotion({ port: Number(process.env.COS_MOCK_NOTION_PORT ?? 4401) }),
		mountLinear({ port: Number(process.env.COS_MOCK_LINEAR_PORT ?? 4402) }),
		mountCalendar({ port: Number(process.env.COS_MOCK_CALENDAR_PORT ?? 4403) }),
		mountEmail({ port: Number(process.env.COS_MOCK_EMAIL_PORT ?? 4404) }),
		mountCommitments({ port: Number(process.env.COS_MOCK_COMMITMENTS_PORT ?? 4405) }),
	]);
	console.log(`[chief-of-staff:mocks] notion      → ${notion.url}`);
	console.log(`[chief-of-staff:mocks] linear      → ${linear.url}`);
	console.log(`[chief-of-staff:mocks] calendar    → ${calendar.url}`);
	console.log(`[chief-of-staff:mocks] email       → ${email.url}`);
	console.log(`[chief-of-staff:mocks] commitments → ${commitments.url} (inline custom)`);
	return {
		notion,
		linear,
		calendar,
		email,
		commitments,
		async stopAll() {
			await Promise.allSettled([
				notion.stop(),
				linear.stop(),
				calendar.stop(),
				email.stop(),
				commitments.stop(),
			]);
		},
	};
}
