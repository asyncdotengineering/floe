/**
 * Calendar (Google Calendar / Microsoft 365 -shaped) mock. Events have
 * title, start/end (ISO 8601 UTC), attendees, location, description,
 * status. Enough surface for a knowledge-worker bot to:
 *   - list upcoming events ("what's on my calendar this week?")
 *   - find a specific event by title fragment
 *   - propose a free slot
 *   - create or update an event
 */
import * as v from 'valibot';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { defineMockService, type MockService } from '../define-mock-service.ts';

export interface CalendarEvent {
	id: string;
	title: string;
	start: string;
	end: string;
	attendees: string[];
	location: string;
	description: string;
	status: 'confirmed' | 'tentative' | 'cancelled';
}

const seedPath = resolvePath(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'seeds',
	'calendar.json',
);

export interface CalendarServiceOptions {
	seed?: CalendarEvent[] | string;
}

export async function calendarService(
	opts: CalendarServiceOptions = {},
): Promise<MockService<CalendarEvent>> {
	return defineMockService<CalendarEvent>({
		name: 'calendar',
		seed: opts.seed ?? seedPath,
		operations: {
			list_events: {
				description:
					'List events between two ISO-8601 timestamps. Both bounds inclusive. Returns up to `limit` events (default 50), newest first.',
				input: v.object({
					start: v.string(),
					end: v.string(),
					limit: v.optional(v.number()),
				}),
				handler: ({ start, end, limit }, store) =>
					store
						.list()
						.filter((e) => e.start >= start && e.start <= end)
						.sort((a, b) => a.start.localeCompare(b.start))
						.slice(0, limit ?? 50),
			},
			find_event: {
				description:
					'Find one event by case-insensitive title substring match. Returns the next-upcoming match, or null.',
				input: v.object({ titleFragment: v.string() }),
				handler: ({ titleFragment }, store) => {
					const needle = titleFragment.toLowerCase();
					const upcoming = store
						.list()
						.filter((e) => e.title.toLowerCase().includes(needle))
						.sort((a, b) => a.start.localeCompare(b.start));
					return upcoming[0] ?? null;
				},
			},
			get_event: {
				description: 'Fetch a single event by id.',
				input: v.object({ id: v.string() }),
				handler: ({ id }, store) => store.get(id),
			},
			create_event: {
				description:
					'Book a new calendar event. Returns the event with its assigned id.',
				input: v.object({
					title: v.string(),
					start: v.string(),
					end: v.string(),
					attendees: v.array(v.string()),
					location: v.optional(v.string()),
					description: v.optional(v.string()),
				}),
				handler: (args, store) => {
					const id = `evt_${Math.random().toString(36).slice(2, 10)}`;
					return store.insert({
						id,
						title: args.title,
						start: args.start,
						end: args.end,
						attendees: args.attendees,
						location: args.location ?? '',
						description: args.description ?? '',
						status: 'confirmed',
					});
				},
			},
			cancel_event: {
				description: 'Cancel an event (sets status: cancelled). Returns the updated event.',
				input: v.object({ id: v.string() }),
				handler: ({ id }, store) => store.update(id, { status: 'cancelled' }),
			},
		},
	});
}
