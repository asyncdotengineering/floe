/**
 * FHIR-lite patient record mock. Not a faithful R4 implementation —
 * a clinic-bot template needs identity verification + appointment
 * scheduling + medication reference, not the full Bundle envelope
 * resource graph.
 *
 * For a real medical bot you'd swap this for a HAPI FHIR or a vendor
 * EHR client; this mock proves the orchestration shape.
 */
import * as v from 'valibot';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { defineMockService, type MockService } from '../define-mock-service.ts';

export interface Appointment {
	id: string;
	provider: string;
	type: string;
	scheduledFor: string;
	status: 'scheduled' | 'completed' | 'canceled' | 'no_show';
	location: string;
}

export interface Patient {
	id: string;
	mrn: string;
	name: { given: string; family: string };
	dob: string;
	phone: string;
	primaryProvider: string;
	allergies: string[];
	activeMeds: string[];
	appointments: Appointment[];
}

const seedPath = resolvePath(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'seeds',
	'patient-fhir.json',
);

export interface PatientFhirServiceOptions {
	seed?: Patient[] | string;
}

export async function patientFhirService(
	opts: PatientFhirServiceOptions = {},
): Promise<MockService<Patient>> {
	return defineMockService<Patient>({
		name: 'patient_fhir',
		seed: opts.seed ?? seedPath,
		operations: {
			verify_identity: {
				description: 'Identity check by MRN + DOB. Returns {verified: true|false} and the patient id on success. This is a SOFT check — production verification would also require a phone OTP or pin.',
				input: v.object({ mrn: v.string(), dob: v.string() }),
				handler: ({ mrn, dob }, store) => {
					const p = store.find((x) => x.mrn === mrn);
					if (!p) return { verified: false, reason: 'mrn_not_found' };
					return p.dob === dob
						? { verified: true, patientId: p.id }
						: { verified: false, reason: 'dob_mismatch' };
				},
			},
			get_patient: {
				description: 'Fetch a patient record by id. Only call after verify_identity returns verified=true.',
				input: v.object({ patientId: v.string() }),
				handler: ({ patientId }, store) => store.get(patientId),
			},
			list_appointments: {
				description: 'List a patient\'s appointments (scheduled + completed). Newest first.',
				input: v.object({ patientId: v.string() }),
				handler: ({ patientId }, store) => {
					const p = store.get(patientId);
					return p ? p.appointments : null;
				},
			},
			schedule_appointment: {
				description: 'Book a new appointment for a verified patient. Returns the appointment with its assigned id.',
				input: v.object({
					patientId: v.string(),
					provider: v.string(),
					type: v.string(),
					scheduledFor: v.string(),
					location: v.string(),
				}),
				handler: ({ patientId, provider, type, scheduledFor, location }, store) => {
					const p = store.get(patientId);
					if (!p) return { error: 'unknown_patient' };
					const id = `appt_${Math.random().toString(36).slice(2, 8)}`;
					const appt: Appointment = {
						id,
						provider,
						type,
						scheduledFor,
						status: 'scheduled',
						location,
					};
					store.update(patientId, { appointments: [...p.appointments, appt] });
					return appt;
				},
			},
			reschedule_appointment: {
				description: 'Move an existing appointment to a new time.',
				input: v.object({
					patientId: v.string(),
					appointmentId: v.string(),
					newScheduledFor: v.string(),
				}),
				handler: ({ patientId, appointmentId, newScheduledFor }, store) => {
					const p = store.get(patientId);
					if (!p) return { error: 'unknown_patient' };
					const next = p.appointments.map((a) =>
						a.id === appointmentId ? { ...a, scheduledFor: newScheduledFor } : a,
					);
					store.update(patientId, { appointments: next });
					return next.find((a) => a.id === appointmentId);
				},
			},
			cancel_appointment: {
				description: 'Cancel a scheduled appointment.',
				input: v.object({ patientId: v.string(), appointmentId: v.string() }),
				handler: ({ patientId, appointmentId }, store) => {
					const p = store.get(patientId);
					if (!p) return { error: 'unknown_patient' };
					const next = p.appointments.map((a) =>
						a.id === appointmentId ? { ...a, status: 'canceled' as const } : a,
					);
					store.update(patientId, { appointments: next });
					return { ok: true };
				},
			},
		},
	});
}
