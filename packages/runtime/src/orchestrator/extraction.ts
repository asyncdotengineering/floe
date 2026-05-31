/**
 * Multi-turn extraction primitives.
 *
 * The LLM gets a `submit_<name>_data` tool with a **nullable** version
 * of the node's schema. It calls the tool with whatever fields it has
 * extracted so far (possibly just one); the runtime merges into
 * `state.activeFlow.data`. Once all `requiredFields` are populated,
 * the node's `onComplete` fires.
 */
import * as v from 'valibot';
import type { ExtractionNode, FloeTool, Transition } from '../types.ts';

export interface ExtractionSubmitToolOptions {
	/**
	 * The user's most recent message. Inlined into the tool description so
	 * the LLM has the exact text to extract from in its working context —
	 * fixes the "model calls submit_X({}) and asks for what the user
	 * already said" failure mode on smaller models. Multilingual by
	 * construction: the LLM reads the message verbatim, no regex.
	 */
	userMessage?: string;
	/**
	 * When this is a retry after a previous empty / no-progress submission
	 * in the same turn, escalate the description with a stronger nudge.
	 */
	retryNudge?: boolean;
}

/**
 * Build the auto-injected `submit_<slug>_data` tool for an extraction
 * node. The tool's parameters are the node's schema with every
 * top-level field coerced to optional+nullable so the LLM can submit
 * partial data without lying about unknown fields.
 */
export function createExtractionSubmitTool(
	node: ExtractionNode,
	missingFields: readonly string[],
	opts: ExtractionSubmitToolOptions = {},
): FloeTool {
	const toolName = `submit_${slugify(node.name)}_data`;
	const stillNeeded =
		missingFields.length > 0
			? `Still needed: ${missingFields.join(', ')}.`
			: 'All required fields collected.';
	const userMsgBlock = opts.userMessage
		? `\n\nThe user's latest message (extract values from THIS exact text — read it ` +
			`literally, in whatever language it's written in):\n"""\n${opts.userMessage}\n"""`
		: '';
	const retryBlock = opts.retryNudge
		? `\n\nIMPORTANT: A previous submit call in this turn produced no field values. ` +
			`The fields above ARE present in the user's message — extract them literally and ` +
			`submit them now. Do NOT call this tool with empty / null args again.`
		: '';
	const description =
		`Submit information extracted from the conversation for the "${node.name}" step. ` +
		`${stillNeeded} Only submit values explicitly provided by the user — omit fields or ` +
		`use null when still unknown. Call this every time you learn a new field value. After ` +
		`submitting, acknowledge what was received in one short sentence, then ask for the next ` +
		`missing field naturally — do NOT list missing fields out loud.` +
		userMsgBlock +
		retryBlock;
	return {
		name: toolName,
		description,
		parameters: toNullablePartialSchema(node.schema),
		async *execute(input): AsyncGenerator<Transition | string> {
			const args = isPlainRecord(input) ? input : {};
			yield { kind: 'extraction_submission', node, args } satisfies Transition;
			yield missingFields.length > 0
				? `Recorded. Still needed: ${missingFields.join(', ')}.`
				: 'Recorded. All required fields are now collected.';
		},
	};
}

/** True when the LLM called submit but populated zero non-null/non-empty fields. */
export function isEmptySubmission(args: Record<string, unknown>): boolean {
	for (const v of Object.values(args)) {
		if (v === null || v === undefined) continue;
		if (typeof v === 'string' && v.trim() === '') continue;
		return false;
	}
	return true;
}

/**
 * Merge submitted args into accumulated data, skipping null/undefined
 * and whitespace-only-strings so a partial submission can't overwrite
 * previously-recorded non-empty fields.
 */
export function mergeExtractionData(
	current: Record<string, unknown>,
	incoming: Record<string, unknown>,
): Record<string, unknown> {
	const next: Record<string, unknown> = { ...current };
	for (const [key, value] of Object.entries(incoming)) {
		if (value === null || value === undefined) continue;
		if (typeof value === 'string' && value.trim() === '') continue;
		next[key] = value;
	}
	return next;
}

/**
 * Compute still-missing required fields. If `node.requiredFields` is
 * unset, infer from the schema's non-optional top-level keys.
 */
export function computeMissingFields(
	node: ExtractionNode,
	data: Record<string, unknown>,
): string[] {
	const required = node.requiredFields ?? inferRequiredFields(node.schema);
	return required.filter((field) => {
		const v = data[field];
		if (v === null || v === undefined) return true;
		if (typeof v === 'string' && v.trim() === '') return true;
		return false;
	});
}

function inferRequiredFields(schema: v.GenericSchema): string[] {
	const s = schema as unknown as {
		type?: string;
		entries?: Record<string, unknown>;
	};
	if (s.type !== 'object' || !s.entries) return [];
	const out: string[] = [];
	for (const [key, entry] of Object.entries(s.entries)) {
		const t = (entry as { type?: string } | undefined)?.type;
		if (t === 'optional' || t === 'nullish' || t === 'nullable') continue;
		out.push(key);
	}
	return out;
}

function toNullablePartialSchema(schema: v.GenericSchema): v.GenericSchema {
	const s = schema as unknown as {
		type?: string;
		entries?: Record<string, v.GenericSchema>;
	};
	if (s.type !== 'object' || !s.entries) {
		return v.optional(v.nullable(schema)) as v.GenericSchema;
	}
	const newEntries: Record<string, v.GenericSchema> = {};
	for (const [key, entry] of Object.entries(s.entries)) {
		newEntries[key] = v.optional(v.nullable(entry)) as v.GenericSchema;
	}
	return v.object(newEntries) as v.GenericSchema;
}

function slugify(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}
