/**
 * Reference JobStore — in-process Map. Survives only the process
 * lifetime. Production replaces with a libSQL / Postgres / Redis-backed
 * store implementing the same `JobStore` interface.
 */
import type { Job, JobFilter, JobStore } from './types.ts';

export class InMemoryJobStore implements JobStore {
	private readonly rows = new Map<string, Job>();

	async save(job: Job): Promise<void> {
		this.rows.set(job.id, structuredClone(job));
	}
	async get(id: string): Promise<Job | null> {
		const j = this.rows.get(id);
		return j ? structuredClone(j) : null;
	}
	async list(filter?: JobFilter): Promise<Job[]> {
		const all = [...this.rows.values()].map((j) => structuredClone(j));
		if (!filter) return all;
		const wantedStatuses = filter.status
			? Array.isArray(filter.status)
				? new Set(filter.status)
				: new Set([filter.status])
			: null;
		return all.filter((j) => {
			if (wantedStatuses && !wantedStatuses.has(j.status)) return false;
			if (filter.worker && j.worker !== filter.worker) return false;
			return true;
		});
	}
	async delete(id: string): Promise<boolean> {
		return this.rows.delete(id);
	}
}
