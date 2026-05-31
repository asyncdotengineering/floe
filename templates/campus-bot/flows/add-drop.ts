/**
 * Add/drop flow — student requests to add or drop a course.
 *
 *   collect-request (Extraction) → check-window (Compute)
 *                                       ├→ explain-add (Reply, end)
 *                                       ├→ explain-drop (Reply, end)
 *                                       └→ window-closed (Reply, end)
 *
 * The window math (which add/drop bucket the current date falls in)
 * is pure TS. The LLM extracts the course code + action and writes
 * the user-facing reply.
 *
 * NOTE: this template uses a mock current-week. In a real system,
 * replace `currentWeek()` with a lookup against the term calendar.
 */
import {
	defineComputeNode,
	defineExtractionNode,
	defineFlow,
	defineReplyNode,
} from '@floe/runtime';
import * as v from 'valibot';

// Mock current week of the term. Swap for a real calendar lookup.
function currentWeek(): number {
	return Number(process.env.CAMPUS_MOCK_TERM_WEEK ?? 3);
}

// Forward declarations.
let checkWindow: ReturnType<typeof defineCheckWindow>;
let explainAdd: ReturnType<typeof defineExplainAdd>;
let explainDrop: ReturnType<typeof defineExplainDrop>;
let windowClosed: ReturnType<typeof defineWindowClosed>;

const collectRequest = defineExtractionNode({
	name: 'collect-request',
	prompt: `Collect two fields to process the add/drop:

  - **courseCode** — department code + number (e.g. "CS 101", "BIOL 240").
  - **action** — either "add" or "drop" (lowercase).

If the student gave both clearly, submit both. If only one is clear,
submit it and ask warmly for the other in one short sentence.`,
	schema: v.object({
		courseCode: v.string(),
		action: v.picklist(['add', 'drop']),
	}),
	requiredFields: ['courseCode', 'action'],
	async onComplete({ courseCode, action }, ctx) {
		ctx.state.courseCode = courseCode;
		ctx.state.action = action;
		ctx.state.week = currentWeek();
		return { kind: 'node', node: checkWindow };
	},
});

function defineCheckWindow() {
	return defineComputeNode({
		name: 'check-window',
		compute(ctx) {
			const action = ctx.state.action as 'add' | 'drop';
			const week = ctx.state.week as number;
			if (action === 'add') {
				ctx.state.addAllowed = week <= 2;
				return { kind: 'node', node: explainAdd };
			}
			// drop
			if (week <= 4) {
				ctx.state.dropMode = 'no-W';
				return { kind: 'node', node: explainDrop };
			}
			if (week <= 10) {
				ctx.state.dropMode = 'with-W';
				return { kind: 'node', node: explainDrop };
			}
			return { kind: 'node', node: windowClosed };
		},
	});
}

function defineExplainAdd() {
	return defineReplyNode({
		name: 'explain-add',
		prompt: (ctx) => {
			const s = ctx.state as {
				courseCode: string;
				week: number;
				addAllowed: boolean;
			};
			return s.addAllowed
				? `Confirm in ONE short sentence that the student can still add ${s.courseCode}. We're in week ${s.week}; the add deadline is end of week 2 — they're inside it. Direct them to the registrar portal to complete the add.`
				: `In ONE short sentence, tell the student the add window closed at the end of week 2 (today is week ${s.week}) and that adding ${s.courseCode} now requires the instructor's late-add signature. Direct them to email the instructor.`;
		},
		next: () => ({ kind: 'end' }),
	});
}

function defineExplainDrop() {
	return defineReplyNode({
		name: 'explain-drop',
		prompt: (ctx) => {
			const s = ctx.state as {
				courseCode: string;
				week: number;
				dropMode: 'no-W' | 'with-W';
			};
			return s.dropMode === 'no-W'
				? `In ONE short sentence, confirm the student can drop ${s.courseCode} cleanly — we're in week ${s.week}, before the no-W deadline at end of week 4. Mention the refund schedule applies and point them to Student Accounts.`
				: `In ONE short sentence, tell the student dropping ${s.courseCode} now (week ${s.week}) will post a W on their transcript (no refund). The drop-with-W window runs through week 10. Ask if they'd still like to proceed.`;
		},
		next: () => ({ kind: 'end' }),
	});
}

function defineWindowClosed() {
	return defineReplyNode({
		name: 'window-closed',
		prompt: (ctx) => {
			const s = ctx.state as { courseCode: string; week: number };
			return `In ONE short sentence, tell the student the drop window has closed (today is week ${s.week}; the last drop deadline was end of week 10). A withdrawal at this point requires Dean's approval and posts as WF unless hardship is documented. Direct them to the registrar.`;
		},
		next: () => ({ kind: 'end' }),
	});
}

checkWindow = defineCheckWindow();
explainAdd = defineExplainAdd();
explainDrop = defineExplainDrop();
windowClosed = defineWindowClosed();

export const addDropFlow = defineFlow({
	name: 'add-drop',
	description:
		'Multi-step course add/drop. Triggered when a student mentions adding or dropping a specific course code ("drop CS 101", "can I still add BIOL 240"). Looks up the current term week and explains the right path: clean add, late-add, no-W drop, with-W drop, or post-window withdrawal.',
	startNode: () => collectRequest,
});
