/**
 * Email (Gmail / Outlook -shaped) mock. Messages have from, to, cc,
 * subject, snippet (preview), body, receivedAt, read/starred flags,
 * labels. Enough surface for a knowledge-worker bot to:
 *   - search the inbox by query / label / sender
 *   - read a specific message
 *   - draft a reply (returns a draft id; production wires real Gmail
 *     drafts API)
 *   - mark messages read / starred
 */
import * as v from 'valibot';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { defineMockService, type MockService } from '../define-mock-service.ts';

export interface EmailMessage {
	id: string;
	from: string;
	to: string[];
	cc: string[];
	subject: string;
	snippet: string;
	body: string;
	receivedAt: string;
	isRead: boolean;
	isStarred: boolean;
	labels: string[];
}

const seedPath = resolvePath(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'seeds',
	'email.json',
);

export interface EmailServiceOptions {
	seed?: EmailMessage[] | string;
}

export async function emailService(
	opts: EmailServiceOptions = {},
): Promise<MockService<EmailMessage>> {
	return defineMockService<EmailMessage>({
		name: 'email',
		seed: opts.seed ?? seedPath,
		operations: {
			search_messages: {
				description:
					'Search the inbox. Optional filters: query (case-insensitive substring over subject + body + from), label, sender, unreadOnly, starredOnly. Returns id + from + subject + snippet + receivedAt + labels. Up to `limit` (default 20), newest first.',
				input: v.object({
					query: v.optional(v.string()),
					label: v.optional(v.string()),
					sender: v.optional(v.string()),
					unreadOnly: v.optional(v.boolean()),
					starredOnly: v.optional(v.boolean()),
					limit: v.optional(v.number()),
				}),
				handler: (args, store) => {
					const q = args.query?.toLowerCase();
					const lab = args.label?.toLowerCase();
					const sender = args.sender?.toLowerCase();
					return store
						.list()
						.filter((m) => {
							if (q) {
								const hay = (m.subject + ' ' + m.body + ' ' + m.from).toLowerCase();
								if (!hay.includes(q)) return false;
							}
							if (lab && !m.labels.some((l) => l.toLowerCase() === lab)) return false;
							if (sender && !m.from.toLowerCase().includes(sender)) return false;
							if (args.unreadOnly && m.isRead) return false;
							if (args.starredOnly && !m.isStarred) return false;
							return true;
						})
						.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
						.slice(0, args.limit ?? 20)
						.map((m) => ({
							id: m.id,
							from: m.from,
							subject: m.subject,
							snippet: m.snippet,
							receivedAt: m.receivedAt,
							labels: m.labels,
							isRead: m.isRead,
							isStarred: m.isStarred,
						}));
				},
			},
			get_message: {
				description: 'Fetch a single email message by id (full body).',
				input: v.object({ id: v.string() }),
				handler: ({ id }, store) => store.get(id),
			},
			draft_reply: {
				description:
					'Create a draft reply to a message. Returns the draft id + the final composed body. Mock — production wires Gmail drafts.create.',
				input: v.object({
					inReplyTo: v.string(),
					body: v.string(),
				}),
				handler: ({ inReplyTo, body }, store) => {
					const original = store.get(inReplyTo);
					if (!original) return { error: 'unknown_message' };
					return {
						ok: true,
						draftId: `dft_${Math.random().toString(36).slice(2, 10)}`,
						inReplyTo,
						to: [original.from],
						subject: original.subject.startsWith('Re:')
							? original.subject
							: `Re: ${original.subject}`,
						body,
					};
				},
			},
			mark_read: {
				description: 'Mark a message as read.',
				input: v.object({ id: v.string() }),
				handler: ({ id }, store) => store.update(id, { isRead: true }),
			},
			star: {
				description: 'Star or unstar a message.',
				input: v.object({ id: v.string(), starred: v.boolean() }),
				handler: ({ id, starred }, store) => store.update(id, { isStarred: starred }),
			},
		},
	});
}
