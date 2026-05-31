/**
 * Custom Commitments MCP — defined INLINE in this template using
 * `defineMockService` from @floe/mock-services.
 *
 * This is the off-catalog primitive in action: the bundled mocks
 * (Notion, Linear, Calendar, Email, etc) don't cover the
 * chief-of-staff-specific concept of "the leader promised X to Y at
 * meeting Z, due W". Rather than fork the package or stretch Linear
 * tickets to mean two things, we define a custom MCP right here. The
 * mounter is generic; the schema and operations are bespoke.
 *
 * Pattern to copy when YOU need a domain none of the bundled mocks
 * cover (sales forecasts, brand assets, internal wiki — anything).
 */
import * as v from 'valibot';
import { defineMockService, mountMockMcp, type MockMcpHandle } from '@floe/mock-services';

export interface Commitment {
	id: string;
	/** What the leader committed to (one sentence). */
	what: string;
	/** Who it was committed to (Slack user id or email or display name). */
	to: string;
	/** Where/how it was committed (meeting title, email thread id, Slack thread). */
	source: string;
	/** ISO date when the commitment was made. */
	madeOn: string;
	/** ISO date when the commitment is due. */
	dueBy: string;
	status: 'open' | 'in_progress' | 'done' | 'dropped';
	/** Optional related Linear ticket id. */
	linearId?: string;
	/** Optional note added by the chief-of-staff bot. */
	note?: string;
}

const seedCommitments: Commitment[] = [
	{
		id: 'cmt_001',
		what: "Send Marc the updated Q3 forecast with the Globex assumption split out",
		to: 'marc@bigvc.example',
		source: 'Board call 2026-05-15',
		madeOn: '2026-05-15',
		dueBy: '2026-05-30',
		status: 'open',
	},
	{
		id: 'cmt_002',
		what: 'Share the rubric for senior→staff eng promotions with the leadership team',
		to: 'leadership-team',
		source: 'Staff meeting 2026-05-19',
		madeOn: '2026-05-19',
		dueBy: '2026-05-29',
		status: 'in_progress',
		note: 'Draft started Sun; planning to share Friday.',
	},
	{
		id: 'cmt_003',
		what: 'Decide on the comparison-table format for the pricing page',
		to: 'dave@acme.example',
		source: 'Slack DM 2026-05-22',
		madeOn: '2026-05-22',
		dueBy: '2026-05-28',
		status: 'open',
		linearId: 'LIN-201',
	},
	{
		id: 'cmt_004',
		what: 'Get Alice the headcount answer for Q4 infra hiring',
		to: 'alice@acme.example',
		source: '1:1 2026-05-20',
		madeOn: '2026-05-20',
		dueBy: '2026-05-27',
		status: 'open',
	},
	{
		id: 'cmt_005',
		what: 'Intro Mark Olsen (Globex) to Priya at the right moment',
		to: 'mark@globex.example',
		source: 'Globex dinner 2026-05-10',
		madeOn: '2026-05-10',
		dueBy: '2026-06-15',
		status: 'open',
	},
];

export async function mountCommitments(opts: { port: number }): Promise<MockMcpHandle> {
	const svc = await defineMockService<Commitment>({
		name: 'commitments',
		seed: seedCommitments,
		operations: {
			list_commitments: {
				description:
					'List the leader-made commitments. Optional filters: status, to (who), overdueOnly (dueBy < today), upcomingWithinDays (N).',
				input: v.object({
					status: v.optional(v.picklist(['open', 'in_progress', 'done', 'dropped'])),
					to: v.optional(v.string()),
					overdueOnly: v.optional(v.boolean()),
					upcomingWithinDays: v.optional(v.number()),
				}),
				handler: ({ status, to, overdueOnly, upcomingWithinDays }, store) => {
					const today = new Date().toISOString().slice(0, 10);
					const horizon = upcomingWithinDays
						? new Date(Date.now() + upcomingWithinDays * 86400_000).toISOString().slice(0, 10)
						: null;
					return store
						.list()
						.filter((c) => {
							if (status && c.status !== status) return false;
							if (to && !c.to.toLowerCase().includes(to.toLowerCase())) return false;
							if (overdueOnly && (c.status === 'done' || c.status === 'dropped' || c.dueBy >= today)) return false;
							if (horizon && c.dueBy > horizon) return false;
							return true;
						})
						.sort((a, b) => a.dueBy.localeCompare(b.dueBy));
				},
			},
			get_commitment: {
				description: 'Fetch one commitment by id.',
				input: v.object({ id: v.string() }),
				handler: ({ id }, store) => store.get(id),
			},
			log_commitment: {
				description:
					'Log a new commitment the leader made. Returns the created commitment with its assigned id.',
				input: v.object({
					what: v.string(),
					to: v.string(),
					source: v.string(),
					madeOn: v.string(),
					dueBy: v.string(),
					linearId: v.optional(v.string()),
					note: v.optional(v.string()),
				}),
				handler: (args, store) => {
					const id = `cmt_${Math.random().toString(36).slice(2, 8)}`;
					return store.insert({
						id,
						status: 'open',
						what: args.what,
						to: args.to,
						source: args.source,
						madeOn: args.madeOn,
						dueBy: args.dueBy,
						...(args.linearId ? { linearId: args.linearId } : {}),
						...(args.note ? { note: args.note } : {}),
					});
				},
			},
			update_commitment_status: {
				description: 'Move a commitment to a new status (open / in_progress / done / dropped).',
				input: v.object({
					id: v.string(),
					status: v.picklist(['open', 'in_progress', 'done', 'dropped']),
					note: v.optional(v.string()),
				}),
				handler: ({ id, status, note }, store) =>
					store.update(id, { status, ...(note ? { note } : {}) }),
			},
		},
	});
	return mountMockMcp(svc, { port: opts.port });
}
