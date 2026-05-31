/**
 * Boundary tests for the report formatters. Pure string output —
 * verify the structure (headers, row count, pass/fail badges) is
 * stable so downstream consumers (CI logs, screenshots) don't drift.
 */
import { describe, expect, it } from 'vitest';
import {
	formatPassMatrix,
	formatLatencyTable,
	formatPassRate,
	formatSampleReplies,
	formatFullReport,
} from '../src/reporter.ts';
import type { BenchReport } from '../src/types.ts';

function makeReport(): BenchReport {
	return {
		ranAt: '2026-05-24T00:00:00.000Z',
		durationMs: 12345,
		models: [
			{
				label: 'gpt-4.1-mini',
				id: 'openai/gpt-4.1-mini',
				durationMs: 5000,
				scenarios: [
					{
						scenarioId: 's1-pass',
						pass: true,
						totalLatencyMs: 1200,
						turns: [
							{
								turnIndex: 0,
								userMessage: 'hello',
								assistantText: 'hi there!',
								ttftMs: 180,
								endToEndMs: 1200,
								events: [],
								state: undefined,
								assertions: [{ name: 'contains', pass: true }],
							},
						],
					},
					{
						scenarioId: 's2-fail',
						pass: false,
						totalLatencyMs: 900,
						turns: [
							{
								turnIndex: 0,
								userMessage: 'ping',
								assistantText: 'no pong here',
								ttftMs: 220,
								endToEndMs: 900,
								events: [],
								state: undefined,
								assertions: [
									{ name: 'contains', pass: false, message: 'missing "pong"' },
								],
							},
						],
					},
				],
			},
		],
		scenarios: [
			{ id: 's1-pass', description: 'happy path', firstUserMessage: 'hello' },
			{ id: 's2-fail', description: 'sad path', firstUserMessage: 'ping' },
		],
	};
}

describe('reporter — formatters', () => {
	it('pass matrix shows ✓ for pass, ✗ for fail', () => {
		const out = formatPassMatrix(makeReport());
		expect(out).toContain('✓ PASS');
		expect(out).toContain('✗ FAIL');
		expect(out).toContain('s1-pass');
		expect(out).toContain('s2-fail');
	});

	it('latency table includes p50/p95 columns', () => {
		const out = formatLatencyTable(makeReport());
		expect(out).toContain('TTFT p50');
		expect(out).toContain('p95');
		expect(out).toContain('gpt-4.1-mini');
	});

	it('pass rate shows scenarios + assertions ratios', () => {
		const out = formatPassRate(makeReport());
		expect(out).toContain('1/2'); // 1 scenario passed of 2
		expect(out).toContain('1/2'); // 1 assertion passed of 2
	});

	it('sample replies includes truncated assistant text', () => {
		const out = formatSampleReplies(makeReport(), 40);
		expect(out).toContain('hi there!');
		expect(out).toContain('no pong here');
	});

	it('full report stitches every section together', () => {
		const out = formatFullReport(makeReport());
		expect(out).toContain('FLOE BENCH');
		expect(out).toContain('PASS RATE');
		expect(out).toContain('LATENCY');
		expect(out).toContain('PER-SCENARIO PASS MATRIX');
		expect(out).toContain('SAMPLE REPLIES');
	});
});
