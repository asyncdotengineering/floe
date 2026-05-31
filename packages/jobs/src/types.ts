/**
 * Job + JobStore + JobRunner contracts. Kept in one file because the
 * surface is tiny and the contracts reference each other.
 */

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Job {
	id: string;
	/** Logical worker name — usually a role from your Assistant config. */
	worker: string;
	/** What the worker should do. The runner's `perform` function decides
	 * how to interpret this (passed verbatim to the user's perform fn). */
	prompt: string;
	status: JobStatus;
	enqueuedAt: string;
	startedAt?: string;
	finishedAt?: string;
	/** Final text result on success. */
	result?: string;
	/** Error message on failure. */
	error?: string;
	/** Free-form caller metadata (correlation ids, request context). */
	metadata?: Record<string, unknown>;
	/** When the requestor wants to be reminded if not done yet. */
	checkInAfter?: string;
}

export interface JobFilter {
	status?: JobStatus | JobStatus[];
	worker?: string;
}

export interface JobStore {
	save(job: Job): Promise<void>;
	get(id: string): Promise<Job | null>;
	list(filter?: JobFilter): Promise<Job[]>;
	delete(id: string): Promise<boolean>;
}

/**
 * The user-supplied function the runner invokes per job. Receives the
 * job (id, prompt, worker, metadata) and returns the final result
 * text. Throw to mark the job failed.
 */
export type PerformFn = (job: Job) => Promise<string>;

export interface EnqueueArgs {
	worker: string;
	prompt: string;
	metadata?: Record<string, unknown>;
	checkInAfter?: string;
}

export interface JobRunnerOptions {
	store?: JobStore;
	/** Max jobs running concurrently. Default 4. */
	concurrency?: number;
	/** The work function. Required. */
	perform: PerformFn;
}

export interface JobRunner {
	enqueue(args: EnqueueArgs): Promise<Job>;
	get(id: string): Promise<Job | null>;
	list(filter?: JobFilter): Promise<Job[]>;
	cancel(id: string): Promise<Job | null>;
	/** Register a listener fired once per terminal job state. Returns an unsubscribe. */
	onComplete(cb: (job: Job) => void | Promise<void>): () => void;
	/** Number of jobs currently `running` (drained from the queue). */
	readonly active: number;
	/** Stop the runner — waits for in-flight jobs, refuses new enqueues. */
	stop(): Promise<void>;
}
