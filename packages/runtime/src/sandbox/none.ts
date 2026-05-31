/**
 * Universal "no sandbox" — minimal in-memory fs, no bash, no network.
 *
 * Use for tests, deterministic agents that don't read files, or when
 * you want to enforce that the agent CANNOT touch any filesystem.
 *
 * `session.fs.readFile/readdir/etc.` all throw with a clear error
 * explaining the user opted out of fs by choosing this sandbox.
 *
 * Universal — runs anywhere (Node, Cloudflare, Bun, Deno, browser).
 */
import type { SandboxFactory, SessionEnv } from '@flue/runtime';

export interface NoneSandboxOptions {
	/** Files to make available (read-only) via session.fs.readFile. Map of relative path → content. */
	files?: Record<string, string>;
}

export function noneSandbox(opts: NoneSandboxOptions = {}): SandboxFactory {
	const files = opts.files ?? {};
	const env: SessionEnv = {
		async exec() {
			throw new Error(
				'[floe] noneSandbox: exec() is disabled. Switch to localSandbox() (Node) or cfBashSandbox() (CF Workers) for shell access.',
			);
		},
		async readFile(p) {
			const c = files[p];
			if (c === undefined) {
				throw new Error(`[floe] noneSandbox: file not found "${p}". Provide it via noneSandbox({files}).`);
			}
			return c;
		},
		async readFileBuffer(p) {
			const c = files[p];
			if (c === undefined) {
				throw new Error(`[floe] noneSandbox: file not found "${p}". Provide it via noneSandbox({files}).`);
			}
			return new TextEncoder().encode(c);
		},
		async writeFile() {
			throw new Error('[floe] noneSandbox is read-only. Provide files at construction.');
		},
		async stat(p) {
			if (files[p] === undefined) {
				throw new Error(`[floe] noneSandbox: file not found "${p}".`);
			}
			return { isFile: true, isDirectory: false, isSymbolicLink: false, size: files[p]!.length, mtime: new Date(0) };
		},
		async readdir(p) {
			const prefix = p.endsWith('/') ? p : `${p}/`;
			return Object.keys(files)
				.filter((k) => k.startsWith(prefix))
				.map((k) => k.slice(prefix.length).split('/')[0]!)
				.filter((s, i, arr) => arr.indexOf(s) === i);
		},
		async exists(p) {
			return files[p] !== undefined;
		},
		async mkdir() {
			throw new Error('[floe] noneSandbox is read-only.');
		},
		async rm() {
			throw new Error('[floe] noneSandbox is read-only.');
		},
		cwd: '/',
		resolvePath: (p: string) => p,
	};
	return {
		createSessionEnv: async () => env,
		tools: () => [],
	};
}
