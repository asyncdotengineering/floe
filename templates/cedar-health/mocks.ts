/**
 * Mock-service lifecycle for cedar-health: Patient FHIR + Rx + Billing
 * MCP servers backed by @floe/mock-services.
 *
 * Swap-to-real: replace the corresponding `mount<X>` with config
 * pointing at your real FHIR / Rx / Billing MCP server. The
 * assistant prompt's operation names match the bundled mocks; if your
 * real backend names operations differently, update the prompt + the
 * MCP server config in floe.config.ts.
 */
import {
	mountPatientFhir,
	mountRx,
	mountBilling,
	type MockMcpHandle,
} from '@floe/mock-services';

export interface MountedMocks {
	patientFhir: MockMcpHandle;
	rx: MockMcpHandle;
	billing: MockMcpHandle;
	stopAll(): Promise<void>;
}

export async function mountAllMocks(): Promise<MountedMocks> {
	const [patientFhir, rx, billing] = await Promise.all([
		mountPatientFhir({ port: Number(process.env.CEDAR_MOCK_FHIR_PORT ?? 4201) }),
		mountRx({ port: Number(process.env.CEDAR_MOCK_RX_PORT ?? 4202) }),
		mountBilling({ port: Number(process.env.CEDAR_MOCK_BILLING_PORT ?? 4203) }),
	]);
	console.log(`[cedar-health:mocks] patient_fhir → ${patientFhir.url}`);
	console.log(`[cedar-health:mocks] rx           → ${rx.url}`);
	console.log(`[cedar-health:mocks] billing      → ${billing.url}`);
	return {
		patientFhir,
		rx,
		billing,
		async stopAll() {
			await Promise.allSettled([patientFhir.stop(), rx.stop(), billing.stop()]);
		},
	};
}
