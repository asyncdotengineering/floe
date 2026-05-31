/**
 * Campus-bot Assistant config — university student-relationship assistant.
 *
 * Built to model the kind of always-on student-facing concierge that
 * universities want to keep relationships warm across academic,
 * financial, and wellbeing surfaces. Three specialist roles plus a
 * directly-available tool surface for student lookup and registrar
 * questions.
 *
 * Channels: web (student portal widget) + voice (phone/IVR).
 *
 * Mode `coordinate` so the host LLM can delegate to one of:
 *   - `academic-advisor` — degree planning, prerequisites, course selection
 *   - `financial-aid`    — aid packages, payment plans, scholarships
 *   - `wellbeing`        — counseling, accessibility, after-hours crisis
 *
 * The host also has direct access to lookup tools so it can answer
 * simple questions ("am I on track for graduation?", "what's my GPA?")
 * without spinning up a specialist.
 *
 * Data: inline mocks in this file (cs_001, cs_002). Swap defineTool
 * bodies for real SIS / Banner / Workday calls when going to production.
 *
 * Citation policy: `'optional'`. Knowledge docs cover policy questions
 * that benefit from a bracketed source. The streaming sanitizer in the
 * runtime strips non-numeric brackets the LLM might hallucinate (see
 * packages/runtime/src/streaming/citation-sanitizer.ts).
 */
import { Assistant, defineTool } from '@floe/runtime';
import { localSandbox } from '@floe/runtime/sandbox/local';
import { workspaceBm25 } from '@floe/runtime/knowledge/workspace-bm25';
import { safety } from '@floe/runtime/validators';
import * as v from 'valibot';

import { addDropFlow } from './flows/add-drop.ts';

// ─── Mock data ──────────────────────────────────────────────────────
// Two students to exercise the lookup paths. Swap for SIS reads.

interface Student {
	studentId: string;
	email: string;
	name: string;
	year: 'freshman' | 'sophomore' | 'junior' | 'senior';
	major: string;
	gpa: number;
	standing: 'good' | 'probation' | 'dismissed';
	advisorEmail: string;
}

const STUDENTS: Record<string, Student> = {
	's_001': {
		studentId: 's_001',
		email: 'maya.tan@uni.example',
		name: 'Maya Tan',
		year: 'junior',
		major: 'Computer Science',
		gpa: 3.42,
		standing: 'good',
		advisorEmail: 'a.lee@uni.example',
	},
	's_002': {
		studentId: 's_002',
		email: 'jordan.park@uni.example',
		name: 'Jordan Park',
		year: 'sophomore',
		major: 'Undeclared',
		gpa: 1.78,
		standing: 'probation',
		advisorEmail: 'r.kim@uni.example',
	},
};

const ENROLLMENTS: Record<string, { term: string; courses: Array<{ code: string; title: string; units: number; midtermGrade?: string }> }> = {
	's_001': {
		term: 'Fall 2026',
		courses: [
			{ code: 'CS 351', title: 'Algorithms', units: 4, midtermGrade: 'B+' },
			{ code: 'CS 343', title: 'Operating Systems', units: 4, midtermGrade: 'A-' },
			{ code: 'STAT 240', title: 'Probability', units: 3, midtermGrade: 'A' },
			{ code: 'WRIT 200', title: 'Tech Writing', units: 3, midtermGrade: 'B' },
		],
	},
	's_002': {
		term: 'Fall 2026',
		courses: [
			{ code: 'BIOL 140', title: 'Intro Bio', units: 4, midtermGrade: 'C-' },
			{ code: 'CHEM 110', title: 'General Chemistry', units: 4, midtermGrade: 'D+' },
			{ code: 'ENG 101', title: 'Composition', units: 3, midtermGrade: 'C' },
		],
	},
};

const AID_PACKAGES: Record<string, { grants: number; loans: number; workStudy: number; balanceDue: number; sapStatus: 'meeting' | 'warning' | 'suspended' }> = {
	's_001': { grants: 8000, loans: 5500, workStudy: 3000, balanceDue: 2150, sapStatus: 'meeting' },
	's_002': { grants: 12000, loans: 5500, workStudy: 0, balanceDue: 980, sapStatus: 'warning' },
};

const COURSE_CATALOG = [
	{ code: 'CS 101', title: 'Intro to Programming', units: 4, prereqs: [] },
	{ code: 'CS 201', title: 'Data Structures', units: 4, prereqs: ['CS 101'] },
	{ code: 'CS 343', title: 'Operating Systems', units: 4, prereqs: ['CS 201'] },
	{ code: 'CS 351', title: 'Algorithms', units: 4, prereqs: ['CS 201'] },
	{ code: 'BIOL 140', title: 'Intro Bio', units: 4, prereqs: [] },
	{ code: 'BIOL 240', title: 'Cell Biology', units: 4, prereqs: ['BIOL 140'] },
	{ code: 'STAT 240', title: 'Probability', units: 3, prereqs: [] },
	{ code: 'PSYC 210', title: 'Cognitive Psych', units: 3, prereqs: [] },
];

const DEADLINES = [
	{ id: 'reg-spring', label: 'Spring registration opens', date: '2026-11-03', kind: 'registration' as const },
	{ id: 'pay-fall', label: 'Fall balance due', date: '2026-10-15', kind: 'payment' as const },
	{ id: 'fafsa', label: 'FAFSA priority deadline', date: '2026-12-01', kind: 'aid' as const },
	{ id: 'scholarship-merit', label: 'Merit scholarship renewal', date: '2027-02-15', kind: 'aid' as const },
];

// ─── Tools ──────────────────────────────────────────────────────────

const lookupStudent = defineTool({
	name: 'lookupStudent',
	description:
		'Look up a student. The `identifier` argument is REQUIRED and must be either ' +
		'the student email (e.g. "maya.tan@uni.example") or the student ID (e.g. ' +
		'"s_001"). Never call this tool without the identifier. Returns name, year, ' +
		'major, GPA, academic standing, and advisor email.',
	parameters: v.object({
		identifier: v.pipe(v.string(), v.minLength(1, 'identifier is required')),
	}),
	interim: 'Looking up the student record...',
	async execute({ identifier }) {
		const id = String(identifier ?? '').trim().toLowerCase();
		if (!id) {
			return {
				error: 'identifier-missing',
				hint: 'Re-invoke lookupStudent with the student email or s_NNN id.',
			};
		}
		for (const s of Object.values(STUDENTS)) {
			if (s.studentId.toLowerCase() === id || s.email.toLowerCase() === id) {
				return s;
			}
		}
		return { error: 'student-not-found', identifier };
	},
});

const getEnrollment = defineTool({
	name: 'getEnrollment',
	description:
		'Get the current-term courses for a known student. The `studentId` argument is ' +
		'REQUIRED (e.g. "s_001"). If you only have the student\'s email, call ' +
		'lookupStudent first to resolve the id. Returns course code, title, units, ' +
		'and midterm grade.',
	parameters: v.object({
		studentId: v.pipe(v.string(), v.minLength(1, 'studentId is required')),
	}),
	async execute({ studentId }) {
		const id = String(studentId ?? '').trim();
		if (!id) {
			return {
				error: 'studentId-missing',
				hint: 'Re-invoke getEnrollment with the s_NNN id from lookupStudent.',
			};
		}
		const e = ENROLLMENTS[id];
		if (!e) return { error: 'no-enrollment-on-file', studentId: id };
		return e;
	},
});

const checkFinancialAid = defineTool({
	name: 'checkFinancialAid',
	description:
		'Get the financial aid package summary for a student. The `studentId` ' +
		'argument is REQUIRED (e.g. "s_001"). If you only have the email, call ' +
		'lookupStudent first to resolve the id. Returns grants, loans, work-study, ' +
		'current balance due, and SAP status.',
	parameters: v.object({
		studentId: v.pipe(v.string(), v.minLength(1, 'studentId is required')),
	}),
	async execute({ studentId }) {
		const id = String(studentId ?? '').trim();
		if (!id) {
			return {
				error: 'studentId-missing',
				hint: 'Re-invoke checkFinancialAid with the s_NNN id from lookupStudent.',
			};
		}
		const a = AID_PACKAGES[id];
		if (!a) return { error: 'no-aid-package', studentId: id };
		return a;
	},
});

const listUpcomingDeadlines = defineTool({
	name: 'listUpcomingDeadlines',
	description:
		'List upcoming campus deadlines. Optional `kind` filter — MUST be one of ' +
		'exactly: "registration", "payment", or "aid" (covers FAFSA + scholarship + ' +
		'aid disbursement deadlines). Omit `kind` to get all upcoming deadlines.',
	parameters: v.object({
		kind: v.optional(v.picklist(['registration', 'payment', 'aid'])),
	}),
	async execute({ kind }) {
		const now = Date.now();
		// Be forgiving: accept common synonyms the LLM might emit.
		const aliases: Record<string, 'registration' | 'payment' | 'aid'> = {
			'financial-aid': 'aid',
			'financial aid': 'aid',
			'fafsa': 'aid',
			'scholarship': 'aid',
			'registration': 'registration',
			'payment': 'payment',
			'tuition': 'payment',
			'aid': 'aid',
		};
		const normalized = kind ? aliases[String(kind).toLowerCase()] : undefined;
		const upcoming = DEADLINES.filter((d) => Date.parse(d.date) >= now - 86_400_000)
			.filter((d) => !normalized || d.kind === normalized)
			.sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
			.slice(0, 6);
		return { count: upcoming.length, deadlines: upcoming };
	},
});

const searchCourses = defineTool({
	name: 'searchCourses',
	description:
		'Search the course catalog by free-text query. The `query` argument is ' +
		'REQUIRED — pass the user\'s search term (e.g. "CS" for CS courses, ' +
		'"biology" for biology, "PSYC 210" for an exact code). Returns up to 8 ' +
		'matching courses with their prerequisites.',
	parameters: v.object({
		query: v.pipe(v.string(), v.minLength(1, 'query is required')),
	}),
	async execute({ query }) {
		const q = String(query ?? '').trim().toLowerCase();
		if (!q) {
			return {
				error: 'query-missing',
				hint: 'Re-invoke searchCourses with the user\'s search term (department code or topic).',
			};
		}
		const hits = COURSE_CATALOG.filter(
			(c) => c.code.toLowerCase().includes(q) || c.title.toLowerCase().includes(q),
		).slice(0, 8);
		return { count: hits.length, courses: hits };
	},
});

const bookAdvisorMeeting = defineTool({
	name: 'bookAdvisorMeeting',
	description:
		'Schedule a 1:1 meeting with the student\'s advisor. ALL THREE arguments are ' +
		'REQUIRED: `studentId` (e.g. "s_001"), `when` (a date/time string the human ' +
		'understood, e.g. "next Tuesday 2pm"), and `topic` (1 short phrase: ' +
		'"major selection", "course planning", "academic standing review"). Returns ' +
		'a confirmation id. The actual calendar push is mocked.',
	parameters: v.object({
		studentId: v.pipe(v.string(), v.minLength(1, 'studentId is required')),
		when: v.pipe(v.string(), v.minLength(1, 'when is required')),
		topic: v.pipe(v.string(), v.minLength(1, 'topic is required')),
	}),
	async execute({ studentId, when, topic }) {
		const id = String(studentId ?? '').trim();
		const w = String(when ?? '').trim();
		const t = String(topic ?? '').trim();
		if (!id || !w || !t) {
			return {
				error: 'args-missing',
				missing: [
					...(id ? [] : ['studentId']),
					...(w ? [] : ['when']),
					...(t ? [] : ['topic']),
				],
				hint: 'Re-invoke bookAdvisorMeeting with all three fields populated.',
			};
		}
		const s = STUDENTS[id];
		if (!s) return { error: 'student-not-found', studentId: id };
		const confirmationId = `apt_${Math.random().toString(36).slice(2, 8)}`;
		return {
			confirmationId,
			advisorEmail: s.advisorEmail,
			scheduledFor: w,
			topic: t,
			status: 'booked',
		};
	},
});

// ─── Assistant ──────────────────────────────────────────────────────

export async function createCampusBot(): Promise<{ assistant: Assistant }> {
	const assistant = new Assistant({
		name: 'campus-bot',
		mode: 'coordinate',
		model: process.env.FLOE_MODEL ?? 'openai/gpt-4.1-mini',
		sandbox: localSandbox(),
		configDir: import.meta.dirname,

		systemPrompt: `You are the university's student-relationship assistant.
You help students with academic, financial, and wellbeing questions
without making them figure out which office to call.

OPERATING RULES (strict):
- If the student gives an email or student id, call lookupStudent first
  before answering anything personal.
- For degree planning, prerequisite, or grade-impact questions →
  delegate to the 'academic-advisor' role.
- For aid package, payment plan, scholarship, or SAP-for-aid questions
  → delegate to the 'financial-aid' role.
- For counseling, mental health, accessibility, food insecurity, or
  Title IX → delegate to the 'wellbeing' role. ALWAYS surface the
  Campus Care Line (1-800-555-CARE) when the student mentions distress,
  crisis, harm, or suicidal ideation — that line is 24/7. Mention 911
  only for imminent emergencies.
- For add/drop questions tied to a specific course, the add-drop flow
  fires automatically — don't pre-answer the policy yourself.
- Never invent grades, GPAs, deadlines, or aid amounts. Use the tools.
- Be warm, brief, direct. 2-4 sentences for chat, 1-2 for voice.
- If you don't have what's needed, say so and point them at the right
  office contact from wellbeing-resources.md / academic-policies.md.

You have direct access to: lookupStudent, getEnrollment,
checkFinancialAid, listUpcomingDeadlines, searchCourses,
bookAdvisorMeeting.`,

		roles: {
			'academic-advisor': {
				name: 'academic-advisor',
				description:
					'Degree planning, course selection, prerequisites, academic standing, grade-impact decisions.',
				instructions: `You are the student's academic advisor.

OPERATING RULES:
- Always call lookupStudent + getEnrollment before advising on courses.
- Reference the help-center policy chunks for SAP, withdrawal, and
  repeat-policy answers. Cite by bracketed number.
- For students on probation (GPA < 2.0), gently surface that and
  recommend they meet with their human advisor before next-term
  registration.
- Offer bookAdvisorMeeting when the question reaches the limit of
  what a chat exchange can resolve.
- DO NOT use delegate() or task() — you ARE the specialist; reply directly.`,
			},
			'financial-aid': {
				name: 'financial-aid',
				description:
					'Aid packages, scholarships, payment plans, work-study, SAP-for-aid, and outside-scholarship reporting.',
				instructions: `You are the financial aid specialist.

OPERATING RULES:
- Always call lookupStudent + checkFinancialAid before quoting amounts.
- Reference the help-center policy chunks for SAP, disbursement, late
  payment, and outside-scholarship rules. Cite by bracketed number.
- If SAP status is "warning" or "suspended", surface that gently and
  explain the appeal process from the policy doc.
- For payment-plan questions, mention the $50 enrollment fee and the
  Student Accounts portal.
- DO NOT use delegate() or task() — you ARE the specialist; reply directly.`,
			},
			wellbeing: {
				name: 'wellbeing',
				description:
					'Counseling, mental health, accessibility, health services, food insecurity, Title IX.',
				instructions: `You are the wellbeing specialist.

OPERATING RULES — read carefully, this is the highest-stakes role:
- For ANY mention of crisis, distress, self-harm, suicidal thoughts,
  or feeling unsafe — surface the Campus Care Line 1-800-555-CARE
  (24/7) IN YOUR FIRST SENTENCE. Always.
- For imminent emergency (active risk) → 911 or campus safety
  1-800-555-SAFE.
- Never minimize. Never tell the student what they should feel.
- Don't promise specific slot availability — the bot has no live
  schedule data. Point them at the office (hours + line listed in
  wellbeing-resources.md).
- For accessibility, food, Title IX questions, route them to the
  right office with location + line.
- DO NOT use delegate() or task() — you ARE the specialist; reply directly.`,
			},
		},

		tools: [
			lookupStudent,
			getEnrollment,
			checkFinancialAid,
			listUpcomingDeadlines,
			searchCourses,
			bookAdvisorMeeting,
		],
		flows: [addDropFlow],

		validators: [safety({ phase: 'postLLM' })],

		knowledge: [
			workspaceBm25({
				name: 'help-center',
				paths: ['knowledge/**/*.md'],
				chunkSize: 600,
			}),
		],

		// Numeric citations welcomed for the policy answers; the runtime's
		// streaming sanitizer strips any hallucinated non-numeric brackets.
		citations: 'optional',
	});

	return { assistant };
}

export default createCampusBot;
