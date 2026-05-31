/**
 * Okta-shaped directory mock. Users have email, display name, group
 * memberships, manager. Enough surface for ops bots to:
 *   - look up the asker's identity by email
 *   - check group membership for access decisions
 *   - find the right manager / oncall to tag on a ticket
 */
import * as v from 'valibot';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { defineMockService, type MockService } from '../define-mock-service.ts';

export interface OktaUser {
	id: string;
	email: string;
	displayName: string;
	department: string;
	title: string;
	manager: string | null;
	groups: string[];
	status: 'active' | 'suspended' | 'deactivated';
}

const seedPath = resolvePath(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'seeds',
	'okta.json',
);

export interface OktaServiceOptions {
	seed?: OktaUser[] | string;
}

export async function oktaService(
	opts: OktaServiceOptions = {},
): Promise<MockService<OktaUser>> {
	return defineMockService<OktaUser>({
		name: 'okta',
		seed: opts.seed ?? seedPath,
		operations: {
			lookup_user_by_email: {
				description: 'Look up an Okta user by email. Returns id, displayName, department, title, manager, groups, status. Returns null if not found.',
				input: v.object({ email: v.string() }),
				handler: ({ email }, store) =>
					store.find((u) => u.email.toLowerCase() === email.toLowerCase()),
			},
			lookup_user_by_id: {
				description: 'Look up an Okta user by id (e.g. u_alice). Same return shape as lookup_user_by_email.',
				input: v.object({ id: v.string() }),
				handler: ({ id }, store) => store.get(id),
			},
			check_group_membership: {
				description: 'Return whether a user is in a group. Returns {member: true|false} and the user\'s full group list for context.',
				input: v.object({ userId: v.string(), group: v.string() }),
				handler: ({ userId, group }, store) => {
					const user = store.get(userId);
					if (!user) return { member: false, groups: [], error: 'unknown_user' };
					return { member: user.groups.includes(group), groups: user.groups };
				},
			},
			find_manager: {
				description: 'Resolve the manager chain for a user (one level up). Returns the manager user object or null at the top of the chain.',
				input: v.object({ userId: v.string() }),
				handler: ({ userId }, store) => {
					const user = store.get(userId);
					if (!user || !user.manager) return null;
					return store.get(user.manager);
				},
			},
			list_group_members: {
				description: 'List every user in a given group. Returns an array of users.',
				input: v.object({ group: v.string() }),
				handler: ({ group }, store) => store.list().filter((u) => u.groups.includes(group)),
			},
		},
	});
}
