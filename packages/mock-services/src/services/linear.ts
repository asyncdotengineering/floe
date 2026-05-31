/**
 * Linear-shaped ticket tracker mock. Tickets have project, title,
 * description, state, priority, assignee, requester, comments.
 * Enough surface for ops bots to file new tickets, query existing
 * ones, and add comments.
 */
import * as v from 'valibot';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { defineMockService, type MockService } from '../define-mock-service.ts';

export type LinearState = 'todo' | 'in_progress' | 'in_review' | 'done' | 'canceled';
export type LinearPriority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';

export interface LinearComment {
	author: string;
	at: string;
	body: string;
}

export interface LinearIssue {
	id: string;
	project: string;
	title: string;
	description: string;
	state: LinearState;
	priority: LinearPriority;
	assignee: string | null;
	requester: string;
	createdAt: string;
	updatedAt: string;
	comments: LinearComment[];
}

const seedPath = resolvePath(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'seeds',
	'linear.json',
);

export interface LinearServiceOptions {
	seed?: LinearIssue[] | string;
	/** Used to assign ids when creating new issues. Default `LIN-`. */
	idPrefix?: string;
}

export async function linearService(
	opts: LinearServiceOptions = {},
): Promise<MockService<LinearIssue>> {
	const idPrefix = opts.idPrefix ?? 'LIN-';
	const svc = await defineMockService<LinearIssue>({
		name: 'linear',
		seed: opts.seed ?? seedPath,
		operations: {
			create_issue: {
				description: 'File a new Linear ticket. Returns the created issue with its assigned id, createdAt, updatedAt.',
				input: v.object({
					project: v.string(),
					title: v.string(),
					description: v.string(),
					priority: v.picklist(['P0', 'P1', 'P2', 'P3', 'P4']),
					requester: v.string(),
					assignee: v.optional(v.string()),
				}),
				handler: (args, store) => {
					const id = nextId(idPrefix, store.list().map((i) => i.id));
					const now = new Date().toISOString();
					const issue: LinearIssue = {
						id,
						project: args.project,
						title: args.title,
						description: args.description,
						state: 'todo',
						priority: args.priority,
						assignee: args.assignee ?? null,
						requester: args.requester,
						createdAt: now,
						updatedAt: now,
						comments: [],
					};
					return store.insert(issue);
				},
			},
			list_issues: {
				description: 'List Linear issues. Optional filters: project, state, assignee, requester. Returns up to `limit` issues (default 20).',
				input: v.object({
					project: v.optional(v.string()),
					state: v.optional(v.picklist(['todo', 'in_progress', 'in_review', 'done', 'canceled'])),
					assignee: v.optional(v.string()),
					requester: v.optional(v.string()),
					limit: v.optional(v.number()),
				}),
				handler: ({ project, state, assignee, requester, limit }, store) => {
					const filtered = store.list().filter((i) =>
						(!project || i.project === project) &&
						(!state || i.state === state) &&
						(!assignee || i.assignee === assignee) &&
						(!requester || i.requester === requester),
					);
					return filtered.slice(0, limit ?? 20);
				},
			},
			get_issue: {
				description: 'Fetch a single Linear issue by id.',
				input: v.object({ id: v.string() }),
				handler: ({ id }, store) => store.get(id),
			},
			add_comment: {
				description: 'Add a comment to an existing issue. Bumps updatedAt.',
				input: v.object({ id: v.string(), author: v.string(), body: v.string() }),
				handler: ({ id, author, body }, store) => {
					const issue = store.get(id);
					if (!issue) return { error: 'unknown_issue', id };
					const now = new Date().toISOString();
					issue.comments.push({ author, at: now, body });
					issue.updatedAt = now;
					store.update(id, { comments: issue.comments, updatedAt: now });
					return store.get(id);
				},
			},
			update_state: {
				description: 'Move an issue to a new state.',
				input: v.object({
					id: v.string(),
					state: v.picklist(['todo', 'in_progress', 'in_review', 'done', 'canceled']),
				}),
				handler: ({ id, state }, store) => {
					const issue = store.get(id);
					if (!issue) return { error: 'unknown_issue', id };
					return store.update(id, { state, updatedAt: new Date().toISOString() });
				},
			},
		},
	});
	return svc;
}

function nextId(prefix: string, existing: string[]): string {
	const nums = existing
		.filter((id) => id.startsWith(prefix))
		.map((id) => parseInt(id.slice(prefix.length), 10))
		.filter((n) => !isNaN(n));
	const next = (nums.length === 0 ? 100 : Math.max(...nums)) + 1;
	return `${prefix}${next}`;
}
