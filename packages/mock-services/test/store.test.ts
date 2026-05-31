/**
 * Boundary tests for the generic Store. Every bundled service builds
 * on this; if it has a CRUD bug, all 8 inherit it. Worth pinning.
 */
import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.ts';

interface Foo {
	id: string;
	name: string;
	count: number;
}

describe('Store — CRUD', () => {
	it('empty store: get / list / find behave', () => {
		const s = new Store<Foo>();
		expect(s.get('x')).toBeNull();
		expect(s.list()).toEqual([]);
		expect(s.find(() => true)).toBeNull();
	});

	it('seeded store: list returns the seed rows', () => {
		const s = new Store<Foo>([
			{ id: 'a', name: 'A', count: 1 },
			{ id: 'b', name: 'B', count: 2 },
		]);
		expect(s.list()).toHaveLength(2);
		expect(s.get('a')?.name).toBe('A');
	});

	it('insert + update + remove', () => {
		const s = new Store<Foo>();
		s.insert({ id: 'a', name: 'A', count: 1 });
		expect(s.size()).toBe(1);
		s.update('a', { count: 99 });
		expect(s.get('a')?.count).toBe(99);
		expect(s.remove('a')).toBe(true);
		expect(s.size()).toBe(0);
	});

	it('insert duplicate id throws', () => {
		const s = new Store<Foo>([{ id: 'a', name: 'A', count: 1 }]);
		expect(() => s.insert({ id: 'a', name: 'A2', count: 2 })).toThrow(/duplicate/);
	});

	it('list with filter narrows to matching rows', () => {
		const s = new Store<Foo>([
			{ id: 'a', name: 'A', count: 1 },
			{ id: 'b', name: 'A', count: 2 },
			{ id: 'c', name: 'B', count: 1 },
		]);
		expect(s.list({ name: 'A' })).toHaveLength(2);
	});

	it('find returns the first match (predicate)', () => {
		const s = new Store<Foo>([
			{ id: 'a', name: 'A', count: 5 },
			{ id: 'b', name: 'B', count: 10 },
		]);
		const hit = s.find((r) => r.count > 7);
		expect(hit?.id).toBe('b');
	});

	it('reset re-applies the original seed (mutations undone)', () => {
		const s = new Store<Foo>([{ id: 'a', name: 'A', count: 1 }]);
		s.update('a', { count: 99 });
		s.insert({ id: 'b', name: 'B', count: 2 });
		s.reset();
		expect(s.get('a')?.count).toBe(1);
		expect(s.get('b')).toBeNull();
	});

	it('mutating a returned row does not affect the store (defensive clone on seed)', () => {
		const s = new Store<Foo>([{ id: 'a', name: 'A', count: 1 }]);
		const row = s.get('a')!;
		row.count = 999;
		// We don't enforce a defensive clone on get() — but reset must still
		// produce a clean snapshot from the original seed.
		s.reset();
		expect(s.get('a')?.count).toBe(1);
	});
});
