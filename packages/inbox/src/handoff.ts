/**
 * Handoff — the human-takeover surface.
 *
 * Per REFACTOR-FIN-HARNESS §4.3:
 *   - HandoffPolicy defines when and how a turn triggers handoff
 *   - InboxPort is the adapter surface (Linear, Slack, built-in)
 *   - LoggingInboxAdapter is the default (logs, returns log-<id>)
 *   - LinearInboxAdapter calls Linear's issueCreate GraphQL mutation
 *
 * A handoff fires when confidence.belowThreshold AND the policy
 * allows it (preTurn/postTurn hooks can veto or force handoff).
 */

import type { Turn } from './turn.ts';

// ─── Decision types ──────────────────────────────────────────────────────

export interface HandoffDecision {
	reason: string;
	summary?: string;
	assignee?: string;
}

export interface HandoffArgs {
	turn: Turn;
	summary: string;
	assignee?: string;
}

export interface HandoffResult {
	ticketId: string;
	source: string;
}

// ─── Port interface ──────────────────────────────────────────────────────

export interface InboxPort {
	open(args: HandoffArgs): Promise<HandoffResult>;
}

// ─── Policy ──────────────────────────────────────────────────────────────

export interface HandoffPolicy {
	/** Confidence threshold below which handoff fires. */
	threshold: number;
	/**
	 * Called BEFORE the LLM response. Return a decision to force/block
	 * handoff before the turn even runs. Return null to defer to
	 * post-turn confidence check.
	 */
	preTurn?: (turn: Turn) => HandoffDecision | null;
	/**
	 * Called AFTER the LLM response. Confidence.belowThreshold is
	 * already checked — this hook can veto (return null) or override
	 * the default handoff decision.
	 */
	postTurn?: (turn: Turn) => HandoffDecision | null;
	/** Where the handoff lands. */
	inbox: InboxPort;
}

// ─── Logging adapter (default) ───────────────────────────────────────────

export class LoggingInboxAdapter implements InboxPort {
	private readonly prefix: string;

	constructor(prefix = 'log') {
		this.prefix = prefix;
	}

	async open(args: HandoffArgs): Promise<HandoffResult> {
		const ticketId = `${this.prefix}-${Math.random().toString(36).slice(2, 10)}`;
		const turnId = args.turn.id;
		const summaryPreview = args.summary.slice(0, 80);
		console.log(
			`[floe:handoff] ticket=${ticketId} turn=${turnId} ` +
				`assignee=${args.assignee ?? '(none)'} summary="${summaryPreview}..."`,
		);
		return { ticketId, source: 'log' };
	}
}
