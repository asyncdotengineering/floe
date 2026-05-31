/**
 * Build the per-turn system prompt + user message for the Assistant /
 * active Node / active Procedures. Pure function — no I/O.
 */
import type {
	ActiveProcedure,
	AssistantMode,
	Flow,
	KnowledgeChunk,
	Node,
	PersonaConfig,
	Procedure,
} from './types.ts';
import type { Role } from '@flue/runtime';
import type * as v from 'valibot';

const VOICE_TRANSCRIPTION_NOTE =
	'You are speaking with a customer over voice. The user message you receive is a transcription and may contain errors. Silently correct for likely transcription errors based on context — for example, misheard names, numbers, or technical terms. If a word makes no sense, infer the most likely intended meaning from surrounding context. Never repeat the corrected text back to the user verbatim; just respond naturally to what they meant.';

export interface PromptBuildArgs {
	assistantSystemPrompt: string;
	activeNode: Node | null;
	activeProcedures: { procedure: Procedure; metadata: { name: string }; body: string }[];
	knowledgeChunks: KnowledgeChunk[];
	voice: boolean;
	transcriptionCorrection: 'default' | 'off' | string;
	/** Pre-rendered memory markdown (from `preloadMemoryContext`). Null = skip. */
	memoryContext?: string | null;
	/** Roles registered on the Assistant — rendered into "# Available roles" for the LLM. */
	roles?: Record<string, Role>;
	/** Coordination mode — affects whether delegate-tool guidance is rendered. */
	mode?: AssistantMode;
	/** Optional structured persona description. */
	persona?: PersonaConfig;
	/**
	 * Flows registered on the Assistant. When non-empty and no flow is
	 * currently active, the runtime renders a `# Available flows` block
	 * + guidance telling the LLM to use the auto-injected
	 * `enter_<flow_name>` tools. Hidden once a flow is active to avoid
	 * tempting the LLM to switch mid-flow.
	 */
	flows?: readonly Flow[];
	/** Whether a flow is currently active — suppresses flow-entry guidance. */
	flowActive?: boolean;
	/** When the active node is an extraction node: still-missing field names. */
	extractionMissingFields?: readonly string[];
	/** When the active node is an extraction node: what's been collected so far. */
	extractionCollectedData?: Readonly<Record<string, unknown>>;
	/**
	 * Pre-loaded contents of `<configDir>/AGENTS.md` (and `CLAUDE.md` if
	 * present). Empty string when neither file exists. The runtime loads
	 * this once per Assistant boot (see `loadProjectContext`); we never
	 * read the file on the hot path.
	 *
	 * Composition order: `assistantSystemPrompt` first (the explicit, code-
	 * controlled prompt), then `projectContext` (file-controlled, the same
	 * AGENTS.md that the rest of the project's agent tooling reads). Both
	 * sit in the cached prompt prefix; provider caches see the same bytes
	 * every turn.
	 */
	projectContext?: string;
	/**
	 * Citation policy for knowledge-chunk references in the LLM reply.
	 * See AssistantConfig.citations for full semantics. Default 'off'.
	 * Voice channel forces 'off' regardless.
	 */
	citations?: 'required' | 'optional' | 'off';
}

export function buildSystemPrompt(args: PromptBuildArgs): string {
	const parts: string[] = [];

	// 1. Voice transcription guidance (if voice).
	if (args.voice && args.transcriptionCorrection !== 'off') {
		parts.push(
			args.transcriptionCorrection === 'default'
				? VOICE_TRANSCRIPTION_NOTE
				: args.transcriptionCorrection,
		);
	}

	// 2. Assistant identity / system prompt.
	parts.push(args.assistantSystemPrompt);

	// 2 (bis). Project context — AGENTS.md + CLAUDE.md from the configDir,
	// loaded once at Assistant boot. The agents.md pattern Vercel's evals
	// validate: always present, never tool-gated, prepended before any
	// per-turn variation so the cache prefix is stable.
	if (args.projectContext && args.projectContext.length > 0) {
		parts.push(`# Project context\n\n${args.projectContext}`);
	}

	// 2a. Persona — structured voice/tone/register guidance.
	const personaBlock = renderPersona(args.persona);
	if (personaBlock) parts.push(personaBlock);

	// 2b. Cross-session memory context (if preloaded).
	if (args.memoryContext) {
		parts.push(args.memoryContext);
	}

	// 2c. Role registry — visible to the LLM so it can pick a delegation target
	// when mode='coordinate'. For mode='direct' / 'route' / 'broadcast' the
	// roles still get injected (cheap and harmless) so the LLM knows the
	// specialty surface; only `coordinate` exposes the `delegate` tool.
	if (args.roles && Object.keys(args.roles).length > 0) {
		const roleLines = Object.entries(args.roles).map(([name, r]) => {
			const desc =
				('description' in r ? (r as { description?: string }).description : undefined) ?? '';
			return `- **${name}**${desc ? `: ${desc}` : ''}`;
		});
		parts.push(`# Available roles\n\n${roleLines.join('\n')}`);

		if (args.mode === 'coordinate') {
			parts.push(
				'# Delegation\n\nWhen a user request falls clearly into a specialist role above, call the `delegate(role, prompt)` tool with the role name and a focused prompt for the specialist. After it returns, weave the result into your reply. Use multiple delegations sequentially when the request spans more than one specialist.',
			);
		}
	}

	// 2d. Flows — auto-injected entry guidance. Tells the LLM that each
	// flow has a dedicated `enter_<name>` tool and that calling it is the
	// ONLY correct way to enter the flow (saying "I'll start your return"
	// in chat does nothing). Hidden once a flow is active.
	if (args.flows && args.flows.length > 0 && !args.flowActive) {
		const lines = args.flows.map((f) => {
			const tool = `enter_${slugifyForTool(f.name)}`;
			const desc = f.description ?? `Start the ${f.name} flow.`;
			return `- **${tool}** — ${desc}`;
		});
		parts.push(
			`# Available flows (multi-step workflows)\n\n${lines.join('\n')}\n\n` +
				"When the user's intent matches one of these flows, call the corresponding " +
				"`enter_<name>` tool — that is the ONLY way to start a flow. Do NOT also " +
				'write a chat reply alongside the tool call; the flow\'s first step will ' +
				'produce the user-facing message. Extract any structured data from the user ' +
				'message (order IDs, product names, customer details) and pass it on the ' +
				'tool\'s `args` field.',
		);
	}

	// 3. Active node prompt (if any). Only Extraction and Capture nodes
	// carry a `prompt` field that flows into the parent-session call; Reply
	// nodes are rendered separately via a fresh child session and Compute
	// nodes have no LLM call at all.
	const activeNodePrompt = nodePromptForSystemRender(args.activeNode);
	if (activeNodePrompt) {
		parts.push(`# Current step\n\n${activeNodePrompt}`);
	}

	// 3a. Extraction-node guidance — the LLM gets a `submit_<node>_data`
	// tool auto-injected; tell it how to use it.
	if (args.activeNode?.kind === 'extraction') {
		const tool = `submit_${slugifyForTool(args.activeNode.name)}_data`;
		const missing = args.extractionMissingFields ?? [];
		const collected = args.extractionCollectedData ?? {};
		const lines = [
			`# Extraction in progress — "${args.activeNode.name}"`,
			'',
			'You are collecting structured information from the user across one or ' +
				`more turns. Submit values using the \`${tool}\` tool every time you ` +
				'learn a new field.',
			'',
			missing.length > 0
				? `**Still needed:** ${missing.join(', ')}.`
				: '**All required fields collected.** Submit any final updates.',
		];
		if (Object.keys(collected).length > 0) {
			lines.push(
				'',
				'**Already collected:**',
				...Object.entries(collected).map(([k, v]) => `- ${k}: ${formatForPrompt(v)}`),
			);
		}
		lines.push(
			'',
			'Rules:',
			'- Submit only values the user explicitly provided — never guess or fabricate.',
			'- Use null for fields you do not yet know; omit fields rather than empty-string.',
			'- After submitting, acknowledge what you heard in ONE short sentence, ' +
				'then ask for the next missing field naturally — never list missing ' +
				'fields out loud, and never read back the structured form to the user.',
		);
		parts.push(lines.join('\n'));
	}

	// 4. Active procedures (inlined bodies, with headers).
	for (const p of args.activeProcedures) {
		parts.push(`# Procedure: ${p.metadata.name}\n\n${p.body}`);
	}

	// 5. Knowledge chunks (always retrieved, agents.md pattern).
	// The hardened rules below — explicit positive AND negative prompting —
	// teach the model when to use the chunks and when to ignore them, so
	// developers don't have to write fragile "should I retrieve?" gates.
	if (args.knowledgeChunks.length > 0) {
		const chunks = args.knowledgeChunks
			.map(
				(c, i) =>
					`[${i + 1}] (source: ${c.source}, score: ${c.score.toFixed(3)})\n${c.text}`,
			)
			.join('\n\n');
		// Voice forces 'off' — "[3]" in synthesized speech is awkward.
		// Default 'off' for everything else too: bracketed citations are
		// visual noise in chat UX and weaker models hallucinate non-numeric
		// brackets (observed with gemini-3.5-flash citing tool names).
		// Opt in to `'required'` for compliance contexts that need a
		// traceability paper trail.
		const citationMode: 'required' | 'optional' | 'off' = args.voice
			? 'off'
			: args.citations ?? 'off';
		const citationGuidance =
			citationMode === 'required'
				? 'CITE by bracketed number when you use a reference — e.g. "Standard shipping is $7 [3]." Multiple cites allowed. Tool outputs are your own knowledge — do NOT bracket-cite them.'
				: citationMode === 'optional'
					? 'You MAY cite by bracketed number when it helps the user verify a claim — e.g. "Standard shipping is $7 [3]." Citations are optional; omit when they would clutter a conversational reply. Tool outputs are your own knowledge — do NOT bracket-cite them.'
					: 'Do NOT add bracketed citations in your reply. Use the reference material naturally without "[1]"-style markers.';
		parts.push(
			`# Reference material

The references below were retrieved for context. **They may or may not be relevant to the user's current message** — apply judgment:

USE the references when:
- The user asks a factual question about policies, products, prices, procedures, or anything else the references plausibly cover.
- A reference clearly answers or constrains the answer to the user's question.

${citationGuidance}

DO NOT use the references when:
- The user is greeting, thanking, or making conversational filler. Reply briefly and warmly without citing anything.
- The references are off-topic for the user's actual question. Don't shoehorn them in to demonstrate research.
- The references don't cover what was asked. Say "I don't have that information" rather than guessing or stretching a partial match into a full claim.

NEVER invent details that aren't in the references — no prices, dates, policies, or specifics that aren't supported.

${chunks}`,
		);
	}

	// 6. Voice-mode response-style guidance.
	if (args.voice) {
		parts.push(
			'# Response style\n\nKeep responses brief and conversational — 1-2 sentences for most turns. No lists, no markdown, no special characters. Speak as if you were a thoughtful human on the phone.',
		);
	}

	// 7. Output-mode guidance.
	if (args.activeNode?.kind === 'capture') {
		parts.push(
			'# Output\n\nCall the `finish` tool with your structured answer. Do not respond in plain text — only a successful `finish` call counts.',
		);
	} else {
		parts.push(
			'# Output\n\nRespond directly with plain text to the user. There is no `finish` tool to call this turn — produce a normal conversational reply.',
		);
	}

	return parts.join('\n\n');
}

export function formatActiveProceduresForState(
	procedures: { procedure: Procedure; metadata: { name: string }; body: string }[],
): ActiveProcedure[] {
	const now = new Date().toISOString();
	return procedures.map((p) => ({ path: p.procedure.path, matchedAt: now }));
}

/**
 * Render a `PersonaConfig` into a Markdown `# Persona` section. Returns
 * `null` when the persona has no useful content, so the caller can simply
 * skip injection. Pure function — no I/O — and safe to call with `undefined`.
 */
export function renderPersona(persona: PersonaConfig | undefined): string | null {
	if (!persona) return null;
	const lines: string[] = [];
	if (persona.voice) lines.push(`- **Voice**: ${persona.voice}`);
	if (persona.tone) lines.push(`- **Tone**: ${persona.tone}`);
	if (persona.register) lines.push(`- **Register**: ${persona.register}`);
	if (persona.pronouns) lines.push(`- **Pronouns**: ${persona.pronouns}`);
	if (persona.avoidPhrases?.length) {
		lines.push(`- **Avoid these phrases**: ${persona.avoidPhrases.map((p) => `"${p}"`).join(', ')}`);
	}
	if (persona.signatureTransitions?.length) {
		lines.push(`- **Preferred transitions**: ${persona.signatureTransitions.map((p) => `"${p}"`).join(', ')}`);
	}
	for (const note of persona.notes ?? []) {
		lines.push(`- ${note}`);
	}
	if (lines.length === 0) return null;
	return `# Persona\n\n${lines.join('\n')}`;
}

/** Mirror of `flow-entry-tools.ts:slugify` — keep the two in sync. */
function slugifyForTool(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/**
 * Per-kind prompt extraction for the parent-session system render.
 * Reply prompts are NOT rendered here — they run in their own child
 * session via the orchestrator's reply path. Compute nodes have no
 * prompt at all.
 */
function nodePromptForSystemRender(node: Node | null): string | undefined {
	if (!node) return undefined;
	if (node.kind === 'extraction') return node.prompt;
	if (node.kind === 'capture') return node.prompt;
	return undefined;
}

function formatForPrompt(value: unknown): string {
	if (value === null || value === undefined) return 'null';
	if (typeof value === 'string') return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
