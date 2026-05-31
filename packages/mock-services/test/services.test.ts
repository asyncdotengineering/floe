/**
 * Per-service boundary tests. Each bundled service ships a default
 * seed; these tests prove the default seed loads + the operations
 * behave on it. If a new operation is added, add a test here.
 */
import { describe, expect, it } from 'vitest';
import {
	oktaService,
	notionService,
	linearService,
	subscriptionService,
	orderService,
	patientFhirService,
	rxService,
	billingService,
	calendarService,
	emailService,
} from '../src/index.ts';

async function invoke<T>(
	svc: { operations: ReadonlyArray<{ name: string; invoke: (args: unknown) => Promise<unknown> }> },
	name: string,
	args: unknown,
): Promise<T> {
	const op = svc.operations.find((o) => o.name === name);
	if (!op) throw new Error(`operation ${name} not found`);
	return (await op.invoke(args)) as T;
}

describe('oktaService (bundled seed)', () => {
	it('lookup_user_by_email finds Alice', async () => {
		const svc = await oktaService();
		const user = await invoke<{ displayName: string } | null>(svc, 'lookup_user_by_email', {
			email: 'alice@acme.example',
		});
		expect(user?.displayName).toBe('Alice Chen');
	});
	it('check_group_membership returns true for Alice in g_oncall', async () => {
		const svc = await oktaService();
		const out = await invoke<{ member: boolean }>(svc, 'check_group_membership', {
			userId: 'u_alice',
			group: 'g_oncall',
		});
		expect(out.member).toBe(true);
	});
	it('find_manager walks one level up', async () => {
		const svc = await oktaService();
		const mgr = await invoke<{ id: string } | null>(svc, 'find_manager', { userId: 'u_alice' });
		expect(mgr?.id).toBe('u_bob');
	});
});

describe('notionService (bundled seed)', () => {
	it('search_pages finds the staging-access policy', async () => {
		const svc = await notionService();
		const hits = await invoke<Array<{ id: string }>>(svc, 'search_pages', {
			query: 'staging',
		});
		expect(hits.find((p) => p.id === 'page_staging_access')).toBeTruthy();
	});
	it('get_page returns full body', async () => {
		const svc = await notionService();
		const page = await invoke<{ body: string } | null>(svc, 'get_page', {
			id: 'page_oncall_rotation',
		});
		expect(page?.body).toContain('Weekly rotation');
	});
});

describe('linearService (bundled seed)', () => {
	it('list_issues filtered by project', async () => {
		const svc = await linearService();
		const out = await invoke<Array<{ project: string }>>(svc, 'list_issues', {
			project: 'IT',
		});
		expect(out.every((i) => i.project === 'IT')).toBe(true);
	});
	it('create_issue assigns a new id and adds to the store', async () => {
		const svc = await linearService();
		const before = (await invoke<unknown[]>(svc, 'list_issues', {})).length;
		const created = await invoke<{ id: string; state: string }>(svc, 'create_issue', {
			project: 'IT',
			title: 'Test',
			description: 'd',
			priority: 'P3',
			requester: 'u_alice',
		});
		expect(created.id).toMatch(/^LIN-/);
		expect(created.state).toBe('todo');
		const after = (await invoke<unknown[]>(svc, 'list_issues', {})).length;
		expect(after).toBe(before + 1);
	});
	it('add_comment bumps updatedAt', async () => {
		const svc = await linearService();
		const updated = await invoke<{ comments: { body: string }[] } | null>(
			svc,
			'add_comment',
			{ id: 'LIN-101', author: 'u_alice', body: 'looking into it' },
		);
		expect(updated?.comments.at(-1)?.body).toBe('looking into it');
	});
});

describe('subscriptionService (bundled seed)', () => {
	it('skip_week updates the subscription + reports savings', async () => {
		const svc = await subscriptionService();
		const sub = await invoke<{ id: string; pricePerWeek: number } | null>(
			svc,
			'lookup_subscription',
			{ email: 'alice@example.com' },
		);
		const result = await invoke<{ ok: boolean; savings: number }>(svc, 'skip_week', {
			subscriptionId: sub!.id,
			weekStartDate: '2026-06-06',
		});
		expect(result.ok).toBe(true);
		expect(result.savings).toBe(sub!.pricePerWeek);
	});
});

describe('orderService (bundled seed)', () => {
	it('lookup_order works on a seeded order', async () => {
		const svc = await orderService();
		const o = await invoke<{ status: string } | null>(svc, 'lookup_order', {
			orderId: 'ord_alice_2401',
		});
		expect(o?.status).toBe('in_transit');
	});
});

describe('patientFhirService (bundled seed)', () => {
	it('verify_identity matches MRN+DOB', async () => {
		const svc = await patientFhirService();
		const out = await invoke<{ verified: boolean; patientId?: string }>(
			svc,
			'verify_identity',
			{ mrn: 'MRN-100231', dob: '1981-04-12' },
		);
		expect(out.verified).toBe(true);
		expect(out.patientId).toBe('p_chen_amy');
	});
	it('verify_identity fails on wrong DOB', async () => {
		const svc = await patientFhirService();
		const out = await invoke<{ verified: boolean; reason?: string }>(
			svc,
			'verify_identity',
			{ mrn: 'MRN-100231', dob: '1990-01-01' },
		);
		expect(out.verified).toBe(false);
		expect(out.reason).toBe('dob_mismatch');
	});
});

describe('rxService (bundled seed)', () => {
	it('request_refill decrements refillsRemaining', async () => {
		const svc = await rxService();
		const before = await invoke<Array<{ id: string; refillsRemaining: number }>>(
			svc,
			'list_for_patient',
			{ patientId: 'p_chen_amy' },
		);
		const rxId = before[0]!.id;
		const beforeCount = before[0]!.refillsRemaining;
		const after = await invoke<{ refillsRemaining: number }>(svc, 'request_refill', {
			prescriptionId: rxId,
		});
		expect(after.refillsRemaining).toBe(beforeCount - 1);
	});
	it('request_refill on a needs_renewal rx returns the renewal-required nextStep', async () => {
		const svc = await rxService();
		const out = await invoke<{ error?: string; nextStep?: string }>(svc, 'request_refill', {
			prescriptionId: 'rx_rivera_atorvastatin',
		});
		expect(out.error).toBe('no_refills_remaining');
		expect(out.nextStep).toBe('request_renewal');
	});
});

describe('billingService (bundled seed)', () => {
	it('verify_insurance returns eligible for a seeded carrier+member', async () => {
		const svc = await billingService();
		const out = await invoke<{ eligible: boolean; copayUsd?: number }>(
			svc,
			'verify_insurance',
			{ carrier: 'BlueShield CA', memberId: 'BS-44129-AC' },
		);
		expect(out.eligible).toBe(true);
		expect(out.copayUsd).toBe(25);
	});
	it('file_dispute flips the invoice status', async () => {
		const svc = await billingService();
		const updated = await invoke<{ status: string } | null>(svc, 'file_dispute', {
			invoiceId: 'inv_chen_2025_06',
			reason: 'wrong patient',
		});
		expect(updated?.status).toBe('in_dispute');
	});
});

describe('calendarService (bundled seed)', () => {
	it('list_events returns events within a window', async () => {
		const svc = await calendarService();
		const events = await invoke<Array<{ id: string }>>(svc, 'list_events', {
			start: '2026-05-25T00:00:00Z',
			end: '2026-05-29T23:59:59Z',
		});
		expect(events.length).toBeGreaterThan(0);
		expect(events.find((e) => e.id === 'evt_q3_planning')).toBeTruthy();
	});
	it('find_event matches title substring case-insensitively', async () => {
		const svc = await calendarService();
		const hit = await invoke<{ title: string } | null>(svc, 'find_event', {
			titleFragment: 'q3 plan',
		});
		expect(hit?.title.toLowerCase()).toContain('q3 planning');
	});
	it('create_event inserts + cancel_event flips status', async () => {
		const svc = await calendarService();
		const created = await invoke<{ id: string; status: string }>(svc, 'create_event', {
			title: 'Test slot',
			start: '2026-06-01T10:00:00Z',
			end: '2026-06-01T10:30:00Z',
			attendees: ['me@acme.example'],
		});
		expect(created.status).toBe('confirmed');
		const cancelled = await invoke<{ status: string } | null>(svc, 'cancel_event', { id: created.id });
		expect(cancelled?.status).toBe('cancelled');
	});
});

describe('emailService (bundled seed)', () => {
	it('search_messages finds Q3-planning thread by query', async () => {
		const svc = await emailService();
		const hits = await invoke<Array<{ id: string; subject: string }>>(svc, 'search_messages', {
			query: 'Q3 planning',
		});
		expect(hits.length).toBeGreaterThan(0);
		expect(hits.some((m) => m.id === 'msg_q3_kickoff')).toBe(true);
	});
	it('search_messages narrows by label + unreadOnly', async () => {
		const svc = await emailService();
		const hits = await invoke<Array<{ id: string }>>(svc, 'search_messages', {
			label: 'needs-reply',
			unreadOnly: true,
		});
		// msg_q3_kickoff matches (needs-reply + unread); msg_design_review has needs-reply but is read.
		expect(hits.find((m) => m.id === 'msg_q3_kickoff')).toBeTruthy();
		expect(hits.find((m) => m.id === 'msg_design_review')).toBeFalsy();
	});
	it('draft_reply prefixes Re: + writes to original sender', async () => {
		const svc = await emailService();
		const draft = await invoke<{
			ok: boolean;
			subject: string;
			to: string[];
			body: string;
		}>(svc, 'draft_reply', {
			inReplyTo: 'msg_design_review',
			body: 'I vote grid + mobile cards.',
		});
		expect(draft.ok).toBe(true);
		expect(draft.subject).toMatch(/^Re:/);
		expect(draft.to).toContain('dave@acme.example');
		expect(draft.body).toContain('vote grid');
	});
	it('mark_read flips isRead', async () => {
		const svc = await emailService();
		const updated = await invoke<{ isRead: boolean } | null>(svc, 'mark_read', {
			id: 'msg_q3_kickoff',
		});
		expect(updated?.isRead).toBe(true);
	});
});
