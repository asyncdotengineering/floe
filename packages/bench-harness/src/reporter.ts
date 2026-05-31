/**
 * Console + JSON reporters. Pure formatting — no I/O of LLM judgements;
 * those happen in `runBench`'s assertion loop.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { summarize } from './percentile.ts';
import type { ModelBenchReport, BenchReport } from './types.ts';

export function formatPassMatrix(report: BenchReport): string {
	const scenarioIds = report.scenarios.map((s) => s.id);
	const modelLabels = report.models.map((m) => m.label);
	const colWidth = Math.max(28, ...scenarioIds.map((s) => s.length));
	const lines: string[] = [];
	lines.push('');
	lines.push('PER-SCENARIO PASS MATRIX:');
	const header = '  ' + 'scenario'.padEnd(colWidth) + modelLabels.map((m) => m.padEnd(14)).join('');
	lines.push(header);
	lines.push('  ' + '-'.repeat(colWidth + modelLabels.length * 14));
	for (const sid of scenarioIds) {
		const row = ['  ' + sid.padEnd(colWidth)];
		for (const m of report.models) {
			const found = m.scenarios.find((s) => s.scenarioId === sid);
			const badge = found
				? found.pass
					? '✓ PASS'
					: '✗ FAIL'
				: '— skip';
			row.push(badge.padEnd(14));
		}
		lines.push(row.join(''));
	}
	return lines.join('\n');
}

export function formatLatencyTable(report: BenchReport): string {
	const lines: string[] = [];
	lines.push('');
	lines.push('LATENCY (across all scenario turns; warmup excluded):');
	lines.push(
		'  ' +
			'model'.padEnd(32) +
			'TTFT p50'.padStart(10) +
			'p95'.padStart(8) +
			'end p50'.padStart(10) +
			'p95'.padStart(8) +
			'n'.padStart(6),
	);
	lines.push('  ' + '-'.repeat(74));
	for (const m of report.models) {
		const ttftValues = m.scenarios.flatMap((s) =>
			s.turns.map((t) => t.ttftMs).filter((v): v is number => v != null),
		);
		const e2eValues = m.scenarios.flatMap((s) => s.turns.map((t) => t.endToEndMs));
		const tt = summarize(ttftValues);
		const ee = summarize(e2eValues);
		lines.push(
			'  ' +
				m.label.padEnd(32) +
				(tt.p50?.toFixed(0) ?? '-').padStart(10) +
				(tt.p95?.toFixed(0) ?? '-').padStart(8) +
				(ee.p50?.toFixed(0) ?? '-').padStart(10) +
				(ee.p95?.toFixed(0) ?? '-').padStart(8) +
				String(ee.n).padStart(6),
		);
	}
	return lines.join('\n');
}

export function formatPassRate(report: BenchReport): string {
	const lines: string[] = [];
	lines.push('');
	lines.push('PASS RATE (scenarios fully green; partial-failures break the row):');
	lines.push('  ' + 'model'.padEnd(32) + 'scenarios'.padStart(16) + 'assertions'.padStart(20));
	lines.push('  ' + '-'.repeat(68));
	for (const m of report.models) {
		const totalScenarios = m.scenarios.length;
		const passedScenarios = m.scenarios.filter((s) => s.pass).length;
		const totalAssertions = m.scenarios.reduce(
			(n, s) => n + s.turns.reduce((nn, t) => nn + t.assertions.length, 0),
			0,
		);
		const passedAssertions = m.scenarios.reduce(
			(n, s) => n + s.turns.reduce((nn, t) => nn + t.assertions.filter((a) => a.pass).length, 0),
			0,
		);
		const pct = totalAssertions === 0 ? 0 : Math.round((passedAssertions / totalAssertions) * 100);
		lines.push(
			'  ' +
				m.label.padEnd(32) +
				`${passedScenarios}/${totalScenarios}`.padStart(16) +
				`${passedAssertions}/${totalAssertions}  (${pct}%)`.padStart(20),
		);
	}
	return lines.join('\n');
}

export function formatSampleReplies(report: BenchReport, maxChars = 140): string {
	const lines: string[] = [];
	lines.push('');
	lines.push('SAMPLE REPLIES (per scenario, first turn, by model):');
	for (const s of report.scenarios) {
		lines.push('');
		lines.push(`  ${s.id}: ${trimEllipsis(s.firstUserMessage, 80)}`);
		for (const m of report.models) {
			const found = m.scenarios.find((sr) => sr.scenarioId === s.id);
			const reply = found?.turns[0]?.assistantText ?? '(no reply)';
			lines.push(`    [${m.label}]: ${trimEllipsis(reply, maxChars)}`);
		}
	}
	return lines.join('\n');
}

export function formatFullReport(report: BenchReport): string {
	return [
		'',
		'=================================================',
		'     FLOE BENCH — final cross-model report',
		'=================================================',
		formatPassRate(report),
		formatLatencyTable(report),
		formatPassMatrix(report),
		formatSampleReplies(report),
	].join('\n');
}

export async function writeJsonReport(path: string, report: BenchReport): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(report, null, 2));
}

function trimEllipsis(s: string, n: number): string {
	const oneLine = s.replace(/\s+/g, ' ');
	return oneLine.length <= n ? oneLine : oneLine.slice(0, n) + '…';
}

export type { ModelBenchReport, BenchReport } from './types.ts';
