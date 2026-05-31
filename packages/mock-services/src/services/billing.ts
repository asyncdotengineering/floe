/**
 * Billing + insurance mock. Invoices reference a patient, have an
 * amount, due date, status, insurance carrier + member id + copay,
 * and a line-item breakdown.
 */
import * as v from 'valibot';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { defineMockService, type MockService } from '../define-mock-service.ts';

export interface InvoiceLineItem {
	code: string;
	description: string;
	amountUsd: number;
}

export interface Invoice {
	id: string;
	patientId: string;
	issuedAt: string;
	amountUsd: number;
	dueDate: string;
	status: 'unpaid' | 'paid' | 'overdue' | 'in_dispute';
	insurance: {
		carrier: string;
		memberId: string;
		copayUsd: number;
	};
	lineItems: InvoiceLineItem[];
}

const seedPath = resolvePath(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'seeds',
	'billing.json',
);

export interface BillingServiceOptions {
	seed?: Invoice[] | string;
}

export async function billingService(
	opts: BillingServiceOptions = {},
): Promise<MockService<Invoice>> {
	return defineMockService<Invoice>({
		name: 'billing',
		seed: opts.seed ?? seedPath,
		operations: {
			list_invoices_for_patient: {
				description: 'List invoices for a patient. Optional status filter (unpaid/paid/overdue/in_dispute).',
				input: v.object({
					patientId: v.string(),
					status: v.optional(v.picklist(['unpaid', 'paid', 'overdue', 'in_dispute'])),
				}),
				handler: ({ patientId, status }, store) =>
					store
						.list()
						.filter((i) => i.patientId === patientId && (!status || i.status === status)),
			},
			get_invoice: {
				description: 'Fetch a single invoice by id.',
				input: v.object({ invoiceId: v.string() }),
				handler: ({ invoiceId }, store) => store.get(invoiceId),
			},
			verify_insurance: {
				description: 'Run an insurance eligibility check (mock). Returns {eligible, copayUsd, deductibleMet} for the carrier + memberId.',
				input: v.object({ carrier: v.string(), memberId: v.string() }),
				handler: ({ carrier, memberId }, store) => {
					const invoice = store.find(
						(i) => i.insurance.carrier === carrier && i.insurance.memberId === memberId,
					);
					if (!invoice) {
						return { eligible: false, reason: 'no_record' };
					}
					return {
						eligible: true,
						copayUsd: invoice.insurance.copayUsd,
						carrier,
						memberId,
					};
				},
			},
			file_dispute: {
				description: 'Flag an invoice as in-dispute. Routes to billing team.',
				input: v.object({ invoiceId: v.string(), reason: v.string() }),
				handler: ({ invoiceId }, store) => store.update(invoiceId, { status: 'in_dispute' }),
			},
		},
	});
}
