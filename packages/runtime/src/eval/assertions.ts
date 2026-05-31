/**
 * Built-in assertion builders. Each is a small pure function that returns
 * a typed `Assertion` you drop into a `Scenario.expect` array.
 *
 * Custom assertions: implement `Assertion` — they're just `{name, check}`.
 */
import type { FlueSession } from '@flue/runtime';
import * as v from 'valibot';
import type { Assertion } from './types.ts';

/** Final text contains a substring (case-insensitive). */
export function contains(needle: string): Assertion {
	const lowerNeedle = needle.toLowerCase();
	return {
		name: `contains("${needle}")`,
		check(ctx) {
			const has = ctx.text.toLowerCase().includes(lowerNeedle);
			return has
				? { pass: true }
				: { pass: false, message: `final reply did not contain "${needle}"`, details: { text: ctx.text } };
		},
	};
}

/** Final text does NOT contain a substring. */
export function notContains(needle: string): Assertion {
	const lowerNeedle = needle.toLowerCase();
	return {
		name: `notContains("${needle}")`,
		check(ctx) {
			const has = ctx.text.toLowerCase().includes(lowerNeedle);
			return has
				? { pass: false, message: `final reply unexpectedly contained "${needle}"`, details: { text: ctx.text } }
				: { pass: true };
		},
	};
}

/** Final text matches a regex. */
export function matches(pattern: RegExp): Assertion {
	return {
		name: `matches(${pattern.source})`,
		check(ctx) {
			return pattern.test(ctx.text)
				? { pass: true }
				: { pass: false, message: `final reply did not match ${pattern.source}`, details: { text: ctx.text } };
		},
	};
}

/** Scenario entered the named flow at least once. */
export function enteredFlow(flowName: string): Assertion {
	return {
		name: `enteredFlow("${flowName}")`,
		check(ctx) {
			const entered = ctx.events.some(
				(e) =>
					e.type === 'conversation_event' &&
					e.subtype === 'flow_enter' &&
					(e.data as { flow?: string })?.flow === flowName,
			);
			return entered
				? { pass: true }
				: { pass: false, message: `flow "${flowName}" was never entered` };
		},
	};
}

/** Scenario emitted no flow_enter events at all (single-agent path). */
export function noFlowEntered(): Assertion {
	return {
		name: 'noFlowEntered()',
		check(ctx) {
			const any = ctx.events.some(
				(e) =>
					e.type === 'conversation_event' &&
					e.subtype === 'flow_enter' &&
					typeof (e.data as { flow?: string })?.flow === 'string',
			);
			return any
				? { pass: false, message: 'unexpected flow_enter event' }
				: { pass: true };
		},
	};
}

/** Flow visited the named node (matches the orchestrator's `node_enter` event, data: {from, to}). */
export function mentionsNode(nodeName: string): Assertion {
	return {
		name: `mentionsNode("${nodeName}")`,
		check(ctx) {
			const found = ctx.events.some((e) => {
				if (e.type !== 'conversation_event') return false;
				if (e.subtype !== 'node_enter' && e.subtype !== 'node_exit') return false;
				const d = e.data as { from?: string; to?: string; node?: string } | undefined;
				return d?.to === nodeName || d?.from === nodeName || d?.node === nodeName;
			});
			return found
				? { pass: true }
				: { pass: false, message: `node "${nodeName}" was not entered or exited` };
		},
	};
}

/** Total cost across all turns is under a USD budget. */
export function costBelow(maxUsd: number): Assertion {
	return {
		name: `costBelow($${maxUsd})`,
		check(ctx) {
			const total = ctx.metrics.reduce((acc, m) => acc + m.tokens.totalCostUsd, 0);
			return total < maxUsd
				? { pass: true, details: { totalUsd: total } }
				: {
						pass: false,
						message: `total cost $${total.toFixed(6)} exceeded budget $${maxUsd}`,
						details: { totalUsd: total },
					};
		},
	};
}

/** Total latency across all turns is under a wall-clock budget. */
export function latencyBelow(maxMs: number): Assertion {
	return {
		name: `latencyBelow(${maxMs}ms)`,
		check(ctx) {
			const total = ctx.metrics.reduce((acc, m) => acc + m.stages.totalMs, 0);
			return total < maxMs
				? { pass: true, details: { totalMs: total } }
				: {
						pass: false,
						message: `total latency ${total}ms exceeded budget ${maxMs}ms`,
						details: { totalMs: total },
					};
		},
	};
}

/**
 * LLM-as-judge assertion. Spins a fresh session.prompt to score whether
 * the assistant's final reply meets the rubric. Returns pass iff
 * `score >= threshold`. Scores are 0..1.
 *
 * NB: this is non-deterministic — re-runs may flip pass/fail near the
 * threshold. Pair with low-temperature models when possible.
 */
export interface LlmJudgeOptions {
	/** A Flue session for the judge call. */
	session: FlueSession;
	/** Plain-language rubric the judge applies. */
	rubric: string;
	/** Min score 0..1 to pass. Default 0.6. */
	threshold?: number;
	/** Override model used for the judge. */
	model?: string;
}

export function llmJudge(opts: LlmJudgeOptions): Assertion {
	const threshold = opts.threshold ?? 0.6;
	const schema = v.object({
		score: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
		reason: v.string(),
	});
	return {
		name: `llmJudge("${opts.rubric.slice(0, 40)}${opts.rubric.length > 40 ? '...' : ''}")`,
		async check(ctx) {
			const prompt = `You are a quality judge for an AI assistant's reply. Score the reply 0..1 against the rubric.

RUBRIC:
${opts.rubric}

ASSISTANT REPLY:
${ctx.text}

Score 1.0 = passes rubric cleanly. 0.5 = partially. 0.0 = fails.
Output JSON: { "score": <0..1 number>, "reason": "<short reason>" }`;
			const response = await opts.session.prompt(prompt, {
				result: schema,
				...(opts.model ? { model: opts.model } : {}),
			});
			const { score, reason } = response.data;
			return score >= threshold
				? { pass: true, details: { score, reason } }
				: {
						pass: false,
						message: `judge scored ${score.toFixed(2)} < threshold ${threshold}: ${reason}`,
						details: { score, reason },
					};
		},
	};
}
