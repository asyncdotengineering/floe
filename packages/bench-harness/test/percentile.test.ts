/**
 * Boundary tests for `percentile` + `summarize`.
 *
 * The math is small but consequential — bench reports lean on these
 * for the p50/p95/p99 columns. Linear interpolation between the two
 * surrounding samples (not nearest-rank). Empty arrays return null
 * across the board so reporters can render a `-` placeholder.
 */
import { describe, expect, it } from 'vitest';
import { percentile, summarize } from '../src/percentile.ts';

describe('percentile', () => {
	it('returns null for empty arrays', () => {
		expect(percentile([], 50)).toBeNull();
		expect(percentile([], 99)).toBeNull();
	});

	it('p0 = min, p100 = max', () => {
		expect(percentile([5, 1, 3, 2, 4], 0)).toBe(1);
		expect(percentile([5, 1, 3, 2, 4], 100)).toBe(5);
	});

	it('p50 of [1..5] = 3 (interpolated, not nearest-rank)', () => {
		expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
	});

	it('p50 of [1, 2] = 1.5 (interpolation)', () => {
		expect(percentile([1, 2], 50)).toBe(1.5);
	});

	it('single value returns that value at any percentile', () => {
		expect(percentile([42], 0)).toBe(42);
		expect(percentile([42], 50)).toBe(42);
		expect(percentile([42], 95)).toBe(42);
		expect(percentile([42], 100)).toBe(42);
	});

	it('rejects out-of-range p', () => {
		expect(() => percentile([1], -1)).toThrow();
		expect(() => percentile([1], 101)).toThrow();
	});
});

describe('summarize', () => {
	it('empty → all nulls + n=0', () => {
		expect(summarize([])).toEqual({
			p50: null,
			p95: null,
			p99: null,
			mean: null,
			n: 0,
		});
	});

	it('returns mean + p50/p95/p99 + n for non-empty', () => {
		const s = summarize([10, 20, 30, 40, 50]);
		expect(s.n).toBe(5);
		expect(s.mean).toBe(30);
		expect(s.p50).toBe(30);
	});
});
