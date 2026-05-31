/**
 * Flow-bot — booking flow demonstrating the first-principles primitives.
 *
 *   collect-booking (Extraction: customerName + slot)
 *     → confirm-booking (Reply, ends T0)
 *   T+1: capture-confirm (Capture) → record-booking (Compute) → booking-confirmed (Reply, end)
 *                                                          └→ booking-cancelled (Reply, end)
 */
import {
	Assistant,
	defineCaptureNode,
	defineComputeNode,
	defineExtractionNode,
	defineFlow,
	defineReplyNode,
} from '@floe/runtime';
import { localSandbox } from '@floe/runtime/sandbox/local';
import * as v from 'valibot';

let confirmBooking: ReturnType<typeof defineConfirmBooking>;
let captureConfirm: ReturnType<typeof defineCaptureConfirm>;
let recordBooking: ReturnType<typeof defineRecordBooking>;
let bookingConfirmed: ReturnType<typeof defineBookingConfirmed>;
let bookingCancelled: ReturnType<typeof defineBookingCancelled>;

const collectBooking = defineExtractionNode({
	name: 'collect-booking',
	prompt: `Collect two fields to book an appointment:

  - **customerName** — the customer's name.
  - **slot** — a normalized booking slot, format "Day at HH:MMam/pm" (e.g. "Friday at 2:00pm").

If they gave both, submit both. If only one, submit it and ask warmly for the other in ONE short sentence.`,
	schema: v.object({
		customerName: v.string(),
		slot: v.string(),
	}),
	requiredFields: ['customerName', 'slot'],
	async onComplete({ customerName, slot }, ctx) {
		ctx.state.customerName = customerName;
		ctx.state.slot = slot;
		return { kind: 'node', node: confirmBooking };
	},
});

function defineConfirmBooking() {
	return defineReplyNode({
		name: 'confirm-booking',
		prompt: (ctx) => {
			const s = ctx.state as { customerName: string; slot: string };
			return `Confirm the booking with the customer. ONE sentence summary + ONE sentence asking yes/no. Plain prose.

# Inputs

- customerName: ${s.customerName}
- slot: ${s.slot}

# Output rules

- MUST contain "${s.customerName}" AND "${s.slot}".
- End with a yes/no ask like "Shall I confirm?" or "Want me to book it?".

Example: "I have you down as ${s.customerName} for ${s.slot}. Shall I confirm the booking?"`;
		},
		next: () => ({ kind: 'node', node: captureConfirm }),
	});
}
confirmBooking = defineConfirmBooking();

function defineCaptureConfirm() {
	return defineCaptureNode({
		name: 'capture-confirm',
		prompt: `The customer's last message is a reply to the booking confirmation. Classify confirmed (true) or declined / ambiguous (false). Emit ONLY the structured result.`,
		schema: v.object({ confirmed: v.boolean() }),
		async handler({ confirmed }, _ctx) {
			if (!confirmed) return { kind: 'node', node: bookingCancelled };
			return { kind: 'node', node: recordBooking };
		},
	});
}
captureConfirm = defineCaptureConfirm();

function defineRecordBooking() {
	return defineComputeNode({
		name: 'record-booking',
		async compute(ctx) {
			ctx.state.confirmationId = `bk_${Math.random().toString(36).slice(2, 8)}`;
			return { kind: 'node', node: bookingConfirmed };
		},
	});
}
recordBooking = defineRecordBooking();

function defineBookingConfirmed() {
	return defineReplyNode({
		name: 'booking-confirmed',
		prompt: (ctx) => {
			const s = ctx.state as {
				customerName: string;
				slot: string;
				confirmationId: string;
			};
			return `Confirm the booking is locked in. ONE sentence. MUST contain "${s.confirmationId}" AND "${s.slot}".

Example: "Done — ${s.customerName}, you're booked for ${s.slot}. Confirmation: ${s.confirmationId}."`;
		},
		next: { kind: 'end', reason: 'booking confirmed' },
	});
}
bookingConfirmed = defineBookingConfirmed();

function defineBookingCancelled() {
	return defineReplyNode({
		name: 'booking-cancelled',
		prompt: `Acknowledge the booking was NOT made. ONE short sentence, plain prose.`,
		next: { kind: 'end', reason: 'booking cancelled' },
	});
}
bookingCancelled = defineBookingCancelled();

const bookingFlow = defineFlow({
	name: 'booking',
	description: 'Multi-step booking — extract name + slot, ask user to confirm, then record.',
	startNode: () => collectBooking,
});

export const concierge = new Assistant({
	name: 'support',
	mode: 'direct',
	systemPrompt: `You are a personal concierge that handles appointment bookings. When a user mentions booking something, enter the booking flow.`,
	model: process.env.FLOE_MODEL ?? 'openai/gpt-4.1-mini',
	thinkingLevel: 'off',
	sandbox: localSandbox(),
	flows: [bookingFlow],
});

export default concierge;
