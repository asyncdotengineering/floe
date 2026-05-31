/**
 * `@floe/mock-services` — seedable in-memory mock backends + auto-mounting
 * MCP servers.
 *
 * Two layers:
 *
 *   1. `defineMockService({name, seed, operations}) + mountMockMcp(svc, opts)`
 *      — the primitive every bundled domain is built on. Use directly when
 *      v1 catalog doesn't cover your domain.
 *
 *   2. `mount<Domain>(opts)` — one-liner convenience wrappers around the
 *      8 v1 bundled domains. Each calls the underlying primitive with
 *      the bundled `seed.json` and a curated operation set.
 */
import type { MountMockMcpOptions, MockMcpHandle } from './mount-mock-mcp.ts';
import { mountMockMcp } from './mount-mock-mcp.ts';
import { oktaService, type OktaServiceOptions } from './services/okta.ts';
import { notionService, type NotionServiceOptions } from './services/notion.ts';
import { linearService, type LinearServiceOptions } from './services/linear.ts';
import {
	subscriptionService,
	type SubscriptionServiceOptions,
} from './services/subscription.ts';
import { orderService, type OrderServiceOptions } from './services/order.ts';
import {
	patientFhirService,
	type PatientFhirServiceOptions,
} from './services/patient-fhir.ts';
import { rxService, type RxServiceOptions } from './services/rx.ts';
import { billingService, type BillingServiceOptions } from './services/billing.ts';
import { calendarService, type CalendarServiceOptions } from './services/calendar.ts';
import { emailService, type EmailServiceOptions } from './services/email.ts';

export { defineMockService } from './define-mock-service.ts';
export type {
	MockService,
	MockOperation,
	DefineMockServiceArgs,
} from './define-mock-service.ts';
export { mountMockMcp } from './mount-mock-mcp.ts';
export type { MountMockMcpOptions, MockMcpHandle } from './mount-mock-mcp.ts';
export { Store } from './store.ts';
export type { Row } from './store.ts';

// ─── Per-domain services (also exported via subpath imports) ───────────
export { oktaService } from './services/okta.ts';
export type { OktaUser, OktaServiceOptions } from './services/okta.ts';
export { notionService } from './services/notion.ts';
export type { NotionPage, NotionServiceOptions } from './services/notion.ts';
export { linearService } from './services/linear.ts';
export type {
	LinearIssue,
	LinearComment,
	LinearState,
	LinearPriority,
	LinearServiceOptions,
} from './services/linear.ts';
export { subscriptionService } from './services/subscription.ts';
export type { Subscription, SubscriptionServiceOptions } from './services/subscription.ts';
export { orderService } from './services/order.ts';
export type { Order, OrderItem, OrderServiceOptions } from './services/order.ts';
export { patientFhirService } from './services/patient-fhir.ts';
export type {
	Patient,
	Appointment,
	PatientFhirServiceOptions,
} from './services/patient-fhir.ts';
export { rxService } from './services/rx.ts';
export type { Prescription, RxServiceOptions } from './services/rx.ts';
export { billingService } from './services/billing.ts';
export type {
	Invoice,
	InvoiceLineItem,
	BillingServiceOptions,
} from './services/billing.ts';
export { calendarService } from './services/calendar.ts';
export type { CalendarEvent, CalendarServiceOptions } from './services/calendar.ts';
export { emailService } from './services/email.ts';
export type { EmailMessage, EmailServiceOptions } from './services/email.ts';

// ─── One-liner `mount<Domain>` convenience wrappers ────────────────────
type MountOpts<SvcOpts> = SvcOpts & Omit<MountMockMcpOptions, 'displayName'>;

export async function mountOkta(opts: MountOpts<OktaServiceOptions>): Promise<MockMcpHandle> {
	const { seed, ...mcpOpts } = opts;
	return mountMockMcp(await oktaService(seed !== undefined ? { seed } : {}), mcpOpts);
}

export async function mountNotion(opts: MountOpts<NotionServiceOptions>): Promise<MockMcpHandle> {
	const { seed, ...mcpOpts } = opts;
	return mountMockMcp(await notionService(seed !== undefined ? { seed } : {}), mcpOpts);
}

export async function mountLinear(opts: MountOpts<LinearServiceOptions>): Promise<MockMcpHandle> {
	const { seed, idPrefix, ...mcpOpts } = opts;
	const svcOpts: LinearServiceOptions = {};
	if (seed !== undefined) svcOpts.seed = seed;
	if (idPrefix !== undefined) svcOpts.idPrefix = idPrefix;
	return mountMockMcp(await linearService(svcOpts), mcpOpts);
}

export async function mountSubscription(
	opts: MountOpts<SubscriptionServiceOptions>,
): Promise<MockMcpHandle> {
	const { seed, ...mcpOpts } = opts;
	return mountMockMcp(
		await subscriptionService(seed !== undefined ? { seed } : {}),
		mcpOpts,
	);
}

export async function mountOrders(opts: MountOpts<OrderServiceOptions>): Promise<MockMcpHandle> {
	const { seed, ...mcpOpts } = opts;
	return mountMockMcp(await orderService(seed !== undefined ? { seed } : {}), mcpOpts);
}

export async function mountPatientFhir(
	opts: MountOpts<PatientFhirServiceOptions>,
): Promise<MockMcpHandle> {
	const { seed, ...mcpOpts } = opts;
	return mountMockMcp(
		await patientFhirService(seed !== undefined ? { seed } : {}),
		mcpOpts,
	);
}

export async function mountRx(opts: MountOpts<RxServiceOptions>): Promise<MockMcpHandle> {
	const { seed, ...mcpOpts } = opts;
	return mountMockMcp(await rxService(seed !== undefined ? { seed } : {}), mcpOpts);
}

export async function mountBilling(
	opts: MountOpts<BillingServiceOptions>,
): Promise<MockMcpHandle> {
	const { seed, ...mcpOpts } = opts;
	return mountMockMcp(await billingService(seed !== undefined ? { seed } : {}), mcpOpts);
}

export async function mountCalendar(
	opts: MountOpts<CalendarServiceOptions>,
): Promise<MockMcpHandle> {
	const { seed, ...mcpOpts } = opts;
	return mountMockMcp(await calendarService(seed !== undefined ? { seed } : {}), mcpOpts);
}

export async function mountEmail(
	opts: MountOpts<EmailServiceOptions>,
): Promise<MockMcpHandle> {
	const { seed, ...mcpOpts } = opts;
	return mountMockMcp(await emailService(seed !== undefined ? { seed } : {}), mcpOpts);
}
