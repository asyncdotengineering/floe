/**
 * Linear inbox adapter — creates Linear issues on handoff.
 *
 * Reference implementation for InboxPort. Calls Linear's issueCreate
 * GraphQL mutation. Auth via LINEAR_API_KEY env var or constructor.
 * Falls back to LoggingInboxAdapter when no key is configured.
 *
 * Per REFACTOR-FIN-HARNESS §4.3 (C-10).
 */

import { LoggingInboxAdapter, type HandoffArgs, type HandoffResult, type InboxPort } from '../handoff.ts';

export class LinearInboxAdapter implements InboxPort {
	private readonly apiKey: string | undefined;
	private readonly teamId?: string;

	constructor(opts?: { apiKey?: string; teamId?: string }) {
		this.apiKey = opts?.apiKey ?? process.env.LINEAR_API_KEY;
		this.teamId = opts?.teamId;
	}

	async open(args: HandoffArgs): Promise<HandoffResult> {
		if (!this.apiKey) {
			const fallback = new LoggingInboxAdapter('linear-fallback');
			return fallback.open(args);
		}

		try {
			const query = `
				mutation IssueCreate($input: IssueCreateInput!) {
					issueCreate(input: $input) {
						success
						issue { id identifier title url }
					}
				}
			`;

			const title = `[Floe Handoff] ${args.turn.conversationId} — ${args.summary.slice(0, 100)}`;
			const variables = {
				input: {
					title,
					description: buildDescription(args),
					...(this.teamId ? { teamId: this.teamId } : {}),
					...(args.assignee ? { assigneeId: args.assignee } : {}),
				},
			};

			const response = await fetch('https://api.linear.app/graphql', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: this.apiKey,
				},
				body: JSON.stringify({ query, variables }),
			});

			const json = (await response.json()) as {
				data?: { issueCreate?: { success: boolean; issue?: { id: string; identifier: string } } };
				errors?: Array<{ message: string }>;
			};

			if (json.errors?.length) {
				throw new Error(json.errors[0]!.message);
			}

			const issue = json.data?.issueCreate?.issue;
			return {
				ticketId: issue?.identifier ?? 'linear-unknown',
				source: 'linear',
			};
		} catch (err) {
			console.error(
				`[floe:handoff] Linear API call failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			const fallback = new LoggingInboxAdapter('linear-error');
			return fallback.open(args);
		}
	}
}

function buildDescription(args: HandoffArgs): string {
	const turn = args.turn;
	return [
		`## Handoff from Floe`,
		``,
		`- **Conversation**: ${turn.conversationId}`,
		`- **Turn**: ${turn.id}`,
		`- **Confidence**: ${turn.confidence.score.toFixed(2)} (below threshold: ${turn.confidence.belowThreshold})`,
		`- **User message**: ${turn.input.text}`,
		`- **Assistant response**: ${turn.assistantText ?? '(none)'}`,
		turn.outcome.type === 'handed_off' ? `- **Handoff reason**: ${turn.outcome.reason}` : '',
		``,
		`## Summary`,
		args.summary,
	]
		.filter(Boolean)
		.join('\n');
}
