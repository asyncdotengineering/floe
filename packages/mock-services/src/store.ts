/**
 * Generic in-memory CRUD store used by every mock service. Flat rows
 * keyed by `id`. No relational joins, no query language — services
 * compose richer operations in TypeScript when needed.
 */
export interface Row {
	id: string;
}

export class Store<T extends Row> {
	private readonly rows: Map<string, T> = new Map();
	private readonly initial: T[];

	constructor(seed: T[] = []) {
		this.initial = [...seed];
		this.reset();
	}

	reset(): void {
		this.rows.clear();
		for (const r of this.initial) this.rows.set(r.id, structuredClone(r));
	}

	get(id: string): T | null {
		return this.rows.get(id) ?? null;
	}

	list(filter?: Partial<T>): T[] {
		const all = [...this.rows.values()];
		if (!filter) return all;
		return all.filter((row) =>
			Object.entries(filter).every(
				([k, v]) => (row as Record<string, unknown>)[k] === v,
			),
		);
	}

	find(predicate: (row: T) => boolean): T | null {
		for (const row of this.rows.values()) {
			if (predicate(row)) return row;
		}
		return null;
	}

	insert(row: T): T {
		if (this.rows.has(row.id)) {
			throw new Error(`[mock-services:Store] duplicate id "${row.id}"`);
		}
		const cloned = structuredClone(row);
		this.rows.set(row.id, cloned);
		return cloned;
	}

	update(id: string, patch: Partial<Omit<T, 'id'>>): T | null {
		const existing = this.rows.get(id);
		if (!existing) return null;
		const merged = { ...existing, ...patch, id } as T;
		this.rows.set(id, merged);
		return merged;
	}

	remove(id: string): boolean {
		return this.rows.delete(id);
	}

	size(): number {
		return this.rows.size;
	}
}
