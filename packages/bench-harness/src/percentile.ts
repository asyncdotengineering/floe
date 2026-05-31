/**
 * Single source of truth for percentile math. Three example bench
 * files previously reinvented this; now they don't.
 */
export function percentile(values: number[], p: number): number | null {
	if (values.length === 0) return null;
	if (p < 0 || p > 100) throw new Error(`[bench:percentile] p must be in [0,100], got ${p}`);
	const sorted = [...values].sort((a, b) => a - b);
	const rank = (p / 100) * (sorted.length - 1);
	const low = Math.floor(rank);
	const high = Math.ceil(rank);
	if (low === high) return sorted[low]!;
	const weight = rank - low;
	return sorted[low]! * (1 - weight) + sorted[high]! * weight;
}

export function summarize(values: number[]): {
	p50: number | null;
	p95: number | null;
	p99: number | null;
	mean: number | null;
	n: number;
} {
	if (values.length === 0) {
		return { p50: null, p95: null, p99: null, mean: null, n: 0 };
	}
	const sum = values.reduce((a, b) => a + b, 0);
	return {
		p50: percentile(values, 50),
		p95: percentile(values, 95),
		p99: percentile(values, 99),
		mean: sum / values.length,
		n: values.length,
	};
}
