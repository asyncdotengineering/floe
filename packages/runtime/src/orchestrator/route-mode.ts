/**
 * `route` mode — runtime triages to ONE role via a small cheap LLM call.
 * Returns the chosen role name; respond.ts applies it as a role overlay
 * on `session.prompt({role: ...})`.
 */
import type { FlueSession, Role } from '@flue/runtime';
import * as v from 'valibot';

export interface RouteSelectionArgs {
	session: FlueSession;
	roles: Record<string, Role>;
	userMessage: string;
	model?: string;
}

/** Returns the chosen role name. Throws if the model fails. */
export async function runRouteSelection(args: RouteSelectionArgs): Promise<string> {
	const { session, roles, userMessage, model } = args;
	const roleNames = Object.keys(roles);
	if (roleNames.length === 0) {
		throw new Error('[floe:route] no roles registered');
	}
	if (roleNames.length === 1) {
		return roleNames[0]!;
	}

	const roleRegistry = roleNames
		.map((n) => {
			const r = roles[n]!;
			const desc =
				('description' in r ? (r as { description?: string }).description : undefined) ?? '';
			return `  - ${n}${desc ? `: ${desc}` : ''}`;
		})
		.join('\n');

	const prompt = `Pick the single best role to handle this user message.

Available roles:
${roleRegistry}

User message: "${userMessage}"

Respond with ONLY the chosen role name (one of: ${roleNames.join(', ')}).`;

	const result = await session.prompt(prompt, {
		model,
		result: v.object({
			role: v.picklist(roleNames as [string, ...string[]]),
		}),
	});

	return result.data.role;
}
