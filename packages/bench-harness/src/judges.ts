/**
 * Optional LLM-as-judge factory for semantic assertions.
 *
 * The harness itself doesn't depend on any judge — callers wire one
 * via the `judges` registry on `runBench`. This module ships
 * `openAiJudge` as the most common case; cross-family judges
 * (Anthropic, local LLM) implement the same `JudgeFn` shape from
 * `@floe/runtime/eval`.
 */
import type { JudgeFn, JudgeVerdict } from '@floe/runtime/eval';

export interface OpenAiJudgeOptions {
	model?: string;
	apiKey?: string;
	baseUrl?: string;
	temperature?: number;
}

export function openAiJudge(opts: OpenAiJudgeOptions = {}): JudgeFn {
	const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
	const model = opts.model ?? 'gpt-4.1-mini';
	const baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1';
	const temperature = opts.temperature ?? 0;
	if (!apiKey) {
		throw new Error('[bench:openAiJudge] OPENAI_API_KEY missing (set env or pass apiKey)');
	}
	return async ({ prompt }): Promise<JudgeVerdict> => {
		const res = await fetch(`${baseUrl}/chat/completions`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				messages: [{ role: 'user', content: prompt }],
				response_format: {
					type: 'json_schema',
					json_schema: {
						name: 'judge_verdict',
						strict: true,
						schema: {
							type: 'object',
							additionalProperties: false,
							properties: {
								pass: { type: 'boolean' },
								reasoning: { type: 'string' },
							},
							required: ['pass', 'reasoning'],
						},
					},
				},
				temperature,
			}),
		});
		if (!res.ok) {
			const body = await res.text().catch(() => '');
			throw new Error(
				`[bench:openAiJudge] ${res.status}: ${body.slice(0, 200)}`,
			);
		}
		const json = (await res.json()) as {
			choices: Array<{ message: { content: string } }>;
		};
		const raw = json.choices[0]?.message?.content ?? '{}';
		const parsed = JSON.parse(raw) as { pass: boolean; reasoning: string };
		return { pass: parsed.pass, reasoning: parsed.reasoning };
	};
}
