/**
 * Floe's `delegate` tool — invokes a specialist role in an isolated
 * child session.
 *
 * Why this exists alongside Flue's builtin `task`: Flue's `task` runs
 * on the same session that's currently holding the prompt lock, which
 * is not what we want for role-based coordination — we want a CLEAN
 * child session per delegation so its history is isolated from the
 * parent conversation. `delegate` does exactly that.
 *
 * Note on the historical `task`-collision bug: pre-patch, an LLM
 * calling Flue's `task` from inside this child's own prompt loop hit
 * `runExclusive('task')` against the still-held prompt lock and threw
 * a cryptic "Session is already running prompt" error → the child LLM
 * degraded to a "technical issue" reply. The fix is upstream-in-spirit:
 * `patches/@flue__runtime@0.7.0.patch` makes `runTaskForTool` return a
 * graceful "task not available in this context" tool result when the
 * session already has an active operation. With the patch in place the
 * LLM recovers cleanly and `delegate` needs no compensating logic.
 *
 * Regression coverage: packages/runtime/test/delegate-collision.test.ts.
 */
import type { FlueHarness, ToolDef, Role } from '@flue/runtime';

export interface DelegateToolOptions {
	harness: FlueHarness;
	roles: Record<string, Role>;
}

export function createDelegateTool({ harness, roles }: DelegateToolOptions): ToolDef {
	const roleNames = Object.keys(roles);
	const roleList = roleNames
		.map((name) => {
			const r = roles[name]!;
			const desc = ('description' in r ? (r as { description?: string }).description : undefined) ?? '';
			return `  - ${name}${desc ? `: ${desc}` : ''}`;
		})
		.join('\n');

	return {
		name: 'delegate',
		description:
			'Delegate this turn (or part of it) to a specialist role. The role runs ' +
			'as a focused child agent with its own isolated context, then returns its ' +
			"reply as text. Use this when the user's request fits one of the named " +
			'roles below. Use it MULTIPLE TIMES sequentially if the request spans more ' +
			'than one specialist.\n\n' +
			`Available roles:\n${roleList}`,
		parameters: {
			type: 'object',
			properties: {
				role: {
					type: 'string',
					enum: roleNames,
					description: 'The specialist role to delegate to.',
				},
				prompt: {
					type: 'string',
					description:
						"The instruction or question to give the specialist. Include any " +
						'context the specialist needs (the specialist does NOT see the parent ' +
						"conversation's history).",
				},
			},
			required: ['role', 'prompt'],
		},
		async execute(args, signal) {
			const { role, prompt } = args as { role: string; prompt: string };
			if (!roles[role]) {
				throw new Error(
					`[floe/delegate] Unknown role "${role}". Available: ${roleNames.join(', ') || '(none)'}.`,
				);
			}
			const child = await harness.session(
				`delegate-${role}-${crypto.randomUUID()}`,
				{ role },
			);
			try {
				const result = await child.prompt(prompt, { signal });
				return result.text || '(specialist returned no text)';
			} finally {
				try {
					const sess = child as unknown as { close?: () => void };
					if (typeof sess.close === 'function') sess.close();
				} catch {
					// noop — best-effort cleanup
				}
			}
		},
	};
}
