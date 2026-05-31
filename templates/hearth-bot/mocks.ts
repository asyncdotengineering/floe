/**
 * Mock-service lifecycle for the hearth-bot template. Subscription +
 * Order MCP servers backed by `@floe/mock-services`.
 *
 * Swap-to-real: replace `mountSubscription`/`mountOrders` with config
 * pointing at your real Subscription API / Order DB MCP server. The
 * assistant prompt doesn't care which.
 */
import {
	mountSubscription,
	mountOrders,
	type MockMcpHandle,
} from '@floe/mock-services';

export interface MountedMocks {
	subscription: MockMcpHandle;
	order: MockMcpHandle;
	stopAll(): Promise<void>;
}

export async function mountAllMocks(): Promise<MountedMocks> {
	const [subscription, order] = await Promise.all([
		mountSubscription({ port: Number(process.env.HEARTH_MOCK_SUBS_PORT ?? 4101) }),
		mountOrders({ port: Number(process.env.HEARTH_MOCK_ORDER_PORT ?? 4102) }),
	]);
	console.log(`[hearth-bot:mocks] subscription → ${subscription.url}`);
	console.log(`[hearth-bot:mocks] order        → ${order.url}`);
	return {
		subscription,
		order,
		async stopAll() {
			await Promise.allSettled([subscription.stop(), order.stop()]);
		},
	};
}
