/**
 * PII redaction validator. Detects common personally-identifiable information
 * patterns and either masks, removes, or hashes them — configurable per call.
 *
 * Phases:
 *   - `preLLM`  — redact USER input before the LLM sees it. Use this for
 *     compliance (HIPAA/PCI/GDPR) where the LLM provider must not receive raw
 *     PII. Rewrites `turn.userMessage` via the `rewrite` ValidationResult.
 *   - `postLLM` — redact ASSISTANT output before it reaches the user (or
 *     downstream logs). Rewrites `turn.assistantText`.
 *
 * Detection is regex-based — pragmatic, not perfect. Production deployments
 * with strict compliance requirements should layer a dedicated PII detector
 * (Presidio, Google DLP, Amazon Comprehend) on top of this validator.
 *
 * Categories: emails, phones, SSNs, credit cards, IP addresses, URLs,
 * IBANs. Disable individual categories via `categories: ['email','phone']`.
 *
 * Strategies:
 *   - `mask`   (default) — replace with `[REDACTED_<CATEGORY>]`
 *   - `remove` — strip the match entirely
 *   - `hash`   — replace with `[<CATEGORY>_<hex8>]` deterministic SHA-256 prefix
 */
import crypto from 'node:crypto';
import { defineValidator } from '../define.ts';
import type { ValidationResult, Validator } from '../types.ts';

export type PiiCategory =
	| 'email'
	| 'phone'
	| 'ssn'
	| 'credit-card'
	| 'ip'
	| 'url'
	| 'iban';

export interface PiiRedactionOptions {
	/** Which detector patterns to run. Default: all categories. */
	categories?: PiiCategory[];
	/** Mask, remove, or hash matches. Default 'mask'. */
	strategy?: 'mask' | 'remove' | 'hash';
	/** Phase: 'preLLM' (default) redacts user input; 'postLLM' redacts assistant text. */
	phase?: 'preLLM' | 'postLLM';
	/** Custom validator name (for telemetry). Default 'pii-redaction'. */
	name?: string;
	/** Override or extend the detector patterns. Custom categories supported. */
	additionalPatterns?: Array<{ category: string; pattern: RegExp }>;
}

interface PatternDef {
	category: string;
	pattern: RegExp;
}

// Order matters: more-specific patterns run BEFORE generic ones, so we
// don't have e.g. SSN format `123-45-6789` swallowed by the loose phone
// regex.
const ALL_CATEGORIES: PiiCategory[] = [
	'email',
	'url',
	'ssn',
	'credit-card',
	'iban',
	'phone',
	'ip',
];

const PATTERN_LIBRARY: Record<PiiCategory, RegExp> = {
	email: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g,
	// US-style (NNN) NNN-NNNN, NNN-NNN-NNNN, +1-NNN-NNN-NNNN, international +CC NN... (10-15 digits)
	phone: /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]?\d{2,4}[\s.-]?\d{2,4}(?:[\s.-]?\d{1,4})?/g,
	ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
	'credit-card':
		// Major schemes (Luhn not enforced — covers Visa, Mastercard, Amex, Discover lengths/prefixes)
		/\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6011|65\d{2})[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
	ip: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
	url: /\bhttps?:\/\/[^\s)>\]]+/gi,
	iban: /\b[A-Z]{2}\d{2}[A-Z0-9]{4,30}\b/g,
};

export function piiRedaction(opts: PiiRedactionOptions = {}): Validator {
	const categories = (opts.categories ?? ALL_CATEGORIES) as string[];
	const strategy = opts.strategy ?? 'mask';
	const phase = opts.phase ?? 'preLLM';
	const name = opts.name ?? 'pii-redaction';

	const patterns: PatternDef[] = [];
	for (const cat of categories) {
		const fromLibrary = PATTERN_LIBRARY[cat as PiiCategory];
		if (fromLibrary) patterns.push({ category: cat, pattern: new RegExp(fromLibrary) });
	}
	for (const extra of opts.additionalPatterns ?? []) {
		patterns.push({ category: extra.category, pattern: new RegExp(extra.pattern) });
	}

	return defineValidator({
		name,
		phase,
		validate(turn): ValidationResult {
			const source = phase === 'preLLM' ? turn.userMessage : turn.assistantText ?? '';
			if (!source) return { ok: true };
			const rewritten = redactString(source, patterns, strategy);
			if (rewritten === source) return { ok: true };
			return { rewrite: rewritten };
		},
	});
}

/** Pure helper — exposed so users can reuse the detector outside validators. */
export function redactString(
	input: string,
	patterns: PatternDef[],
	strategy: 'mask' | 'remove' | 'hash' = 'mask',
): string {
	let out = input;
	for (const { category, pattern } of patterns) {
		// Use a fresh regex each iteration to avoid stateful matching when
		// the input pattern is global.
		const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
		out = out.replace(re, (match) => replacement(category, match, strategy));
	}
	return out;
}

function replacement(category: string, match: string, strategy: 'mask' | 'remove' | 'hash'): string {
	if (strategy === 'remove') return '';
	if (strategy === 'hash') {
		const h = crypto.createHash('sha256').update(match).digest('hex').slice(0, 8);
		return `[${category.toUpperCase()}_${h}]`;
	}
	return `[REDACTED_${category.toUpperCase()}]`;
}
