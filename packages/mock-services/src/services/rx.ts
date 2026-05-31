/**
 * Prescription / Rx system mock. Operations for the common refill +
 * renewal flows clinic bots handle.
 */
import * as v from 'valibot';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { defineMockService, type MockService } from '../define-mock-service.ts';

export interface Prescription {
	id: string;
	patientId: string;
	medication: string;
	prescriber: string;
	writtenOn: string;
	refillsRemaining: number;
	lastFilledAt: string;
	pharmacy: string;
	status: 'active' | 'needs_renewal' | 'expired' | 'discontinued';
}

const seedPath = resolvePath(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'seeds',
	'rx.json',
);

export interface RxServiceOptions {
	seed?: Prescription[] | string;
}

export async function rxService(
	opts: RxServiceOptions = {},
): Promise<MockService<Prescription>> {
	return defineMockService<Prescription>({
		name: 'rx',
		seed: opts.seed ?? seedPath,
		operations: {
			list_for_patient: {
				description: 'List every prescription for a patient. Returns id + medication + status + refillsRemaining + lastFilledAt + pharmacy.',
				input: v.object({ patientId: v.string() }),
				handler: ({ patientId }, store) =>
					store.list().filter((r) => r.patientId === patientId),
			},
			request_refill: {
				description: 'Request a refill for a prescription. Succeeds if refillsRemaining > 0. Decrements refillsRemaining, bumps lastFilledAt. Returns the updated prescription OR an error with the required next step (renewal).',
				input: v.object({ prescriptionId: v.string() }),
				handler: ({ prescriptionId }, store) => {
					const rx = store.get(prescriptionId);
					if (!rx) return { error: 'unknown_prescription' };
					if (rx.refillsRemaining <= 0) {
						return {
							error: 'no_refills_remaining',
							nextStep: 'request_renewal',
							prescriber: rx.prescriber,
							pharmacy: rx.pharmacy,
						};
					}
					return store.update(prescriptionId, {
						refillsRemaining: rx.refillsRemaining - 1,
						lastFilledAt: new Date().toISOString(),
					});
				},
			},
			request_renewal: {
				description: 'Request a renewal — the bot routes this to the prescriber. Returns a renewal request id and the prescriber + pharmacy info. Mock always succeeds.',
				input: v.object({ prescriptionId: v.string(), notesForPrescriber: v.optional(v.string()) }),
				handler: ({ prescriptionId }, store) => {
					const rx = store.get(prescriptionId);
					if (!rx) return { error: 'unknown_prescription' };
					return {
						ok: true,
						renewalRequestId: `rrq_${Math.random().toString(36).slice(2, 10)}`,
						prescriber: rx.prescriber,
						pharmacy: rx.pharmacy,
						medication: rx.medication,
					};
				},
			},
		},
	});
}
