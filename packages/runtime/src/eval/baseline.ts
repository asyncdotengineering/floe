/**
 * Baseline regression diffing. Persist a `RunReport` to JSON, then diff
 * the next run against it — fail when previously-passing scenarios now
 * fail (regression), and surface newly-passing scenarios (improvement).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { BaselineDiff, RunReport, ScenarioRunResult } from './types.ts';

export function saveBaseline(report: RunReport, path: string): void {
	writeFileSync(path, JSON.stringify(report, null, 2));
}

export function loadBaseline(path: string): RunReport {
	const raw = readFileSync(path, 'utf8');
	return JSON.parse(raw) as RunReport;
}

export function diffAgainstBaseline(current: RunReport, baseline: RunReport): BaselineDiff {
	const baselineMap = new Map<string, ScenarioRunResult>();
	for (const r of baseline.results) baselineMap.set(r.scenarioId, r);
	const currentMap = new Map<string, ScenarioRunResult>();
	for (const r of current.results) currentMap.set(r.scenarioId, r);

	const regressions: ScenarioRunResult[] = [];
	const improvements: ScenarioRunResult[] = [];
	const newScenarios: ScenarioRunResult[] = [];

	for (const r of current.results) {
		const prior = baselineMap.get(r.scenarioId);
		if (!prior) {
			newScenarios.push(r);
			continue;
		}
		if (prior.pass && !r.pass) regressions.push(r);
		else if (!prior.pass && r.pass) improvements.push(r);
	}

	const removedScenarios: string[] = [];
	for (const id of baselineMap.keys()) {
		if (!currentMap.has(id)) removedScenarios.push(id);
	}

	return { regressions, improvements, newScenarios, removedScenarios };
}

export function formatDiff(diff: BaselineDiff): string {
	const lines: string[] = [];
	if (diff.regressions.length > 0) {
		lines.push(`❌ REGRESSIONS (${diff.regressions.length}):`);
		for (const r of diff.regressions) {
			lines.push(`  - ${r.scenarioId}: ${r.assertions.filter((a) => !a.result.pass).map((a) => a.name).join(', ')}`);
		}
	}
	if (diff.improvements.length > 0) {
		lines.push(`✅ IMPROVEMENTS (${diff.improvements.length}):`);
		for (const r of diff.improvements) lines.push(`  - ${r.scenarioId}`);
	}
	if (diff.newScenarios.length > 0) {
		lines.push(`➕ NEW (${diff.newScenarios.length}):`);
		for (const r of diff.newScenarios) lines.push(`  - ${r.scenarioId} (${r.pass ? 'PASS' : 'FAIL'})`);
	}
	if (diff.removedScenarios.length > 0) {
		lines.push(`➖ REMOVED (${diff.removedScenarios.length}):`);
		for (const id of diff.removedScenarios) lines.push(`  - ${id}`);
	}
	if (lines.length === 0) lines.push('No changes vs baseline.');
	return lines.join('\n');
}
