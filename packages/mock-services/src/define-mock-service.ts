/**
 * `defineMockService` — the primitive every bundled mock domain is
 * built on. Users define their own with the same shape when the
 * v1 catalog doesn't cover their domain.
 *
 * Each service declares:
 *   - `name` — becomes the MCP server name + tool-name prefix
 *   - `seed` — inline rows OR a path to a JSON file
 *   - `operations` — a map of `name → MockOperation` describing the
 *     LLM-facing tool surface. Each operation carries a valibot schema
 *     for input validation and a handler that receives validated args
 *     plus the shared in-memory store.
 *
 * The returned `MockService` is consumed by `mountMockMcp` to produce
 * a running MCP server. Stop the server via the returned handle's
 * `.stop()`.
 */
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import * as v from 'valibot';
import { Store, type Row } from './store.ts';

export interface MockOperation<T extends Row, In, Out> {
	description: string;
	input: v.BaseSchema<In, In, v.BaseIssue<unknown>>;
	handler: (args: In, store: Store<T>) => Out | Promise<Out>;
}

// The operations map is intentionally heterogeneous — each entry can
// carry its own In/Out types tied to its own valibot schema. TypeScript's
// variance can't track that cleanly through a `Record`, so we use `any`
// here. Runtime validation by valibot is the source of truth.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MockOperationsMap<T extends Row> = Record<string, MockOperation<T, any, any>>;

export interface DefineMockServiceArgs<T extends Row> {
	name: string;
	seed?: T[] | string;
	operations: MockOperationsMap<T>;
}

export interface MockService<T extends Row = Row> {
	readonly name: string;
	readonly store: Store<T>;
	readonly operations: ReadonlyArray<{
		name: string;
		description: string;
		input: v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>;
		invoke: (args: unknown) => Promise<unknown>;
	}>;
	/** Snapshot — re-applies the original seed. Useful between tests. */
	reset(): void;
	/** Hot-replace the entire row set (e.g. test setup). */
	replaceData(rows: T[]): void;
}

export async function defineMockService<T extends Row>(
	args: DefineMockServiceArgs<T>,
): Promise<MockService<T>> {
	const seedRows = await loadSeed(args.seed);
	const store = new Store<T>(seedRows);
	const ops = Object.entries(args.operations).map(([opName, op]) => ({
		name: opName,
		description: op.description,
		input: op.input as v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
		invoke: async (raw: unknown) => {
			const parsed = v.parse(op.input, raw);
			return await op.handler(parsed as never, store);
		},
	}));
	return {
		name: args.name,
		store,
		operations: ops,
		reset: () => store.reset(),
		replaceData: (rows: T[]) => {
			store.reset();
			for (const r of rows) store.insert(r);
		},
	};
}

async function loadSeed<T>(seed: T[] | string | undefined): Promise<T[]> {
	if (!seed) return [];
	if (Array.isArray(seed)) return seed;
	const path = resolvePath(process.cwd(), seed);
	const raw = await readFile(path, 'utf8');
	const parsed = JSON.parse(raw);
	if (!Array.isArray(parsed)) {
		throw new Error(`[mock-services] seed file ${path} must contain a JSON array`);
	}
	return parsed as T[];
}
