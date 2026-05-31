/**
 * Shared test helpers — a minimal in-memory FlueSession good enough for
 * exercising procedure-loader, knowledge sources, and state utilities.
 *
 * We do NOT try to mock session.prompt() — anything that touches the LLM
 * lives in the live integration test (examples/support-bot/test/live.test.ts).
 */
import type { FlueSession } from '@flue/runtime';

export interface MockFs {
	files: Record<string, string>;
}

export function mockSession(fs: MockFs = { files: {} }): FlueSession {
	const session: Record<string, unknown> = {
		metadata: {},
		fs: {
			async readFile(path: string): Promise<string> {
				const v = fs.files[normalize(path)];
				if (v === undefined) throw new Error(`ENOENT: ${path}`);
				return v;
			},
			async writeFile(path: string, content: string): Promise<void> {
				fs.files[normalize(path)] = content;
			},
			async exists(path: string): Promise<boolean> {
				const norm = normalize(path);
				if (fs.files[norm] !== undefined) return true;
				return Object.keys(fs.files).some((p) => p.startsWith(norm + '/'));
			},
			async stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean }> {
				const norm = normalize(path);
				if (fs.files[norm] !== undefined) return { isFile: true, isDirectory: false };
				const isDir = Object.keys(fs.files).some((p) => p.startsWith(norm + '/'));
				if (isDir) return { isFile: false, isDirectory: true };
				throw new Error(`ENOENT: ${path}`);
			},
			async readdir(path: string): Promise<string[]> {
				const norm = normalize(path);
				const prefix = norm === '.' ? '' : `${norm}/`;
				const seen = new Set<string>();
				for (const f of Object.keys(fs.files)) {
					if (!f.startsWith(prefix)) continue;
					const rest = f.slice(prefix.length);
					const slash = rest.indexOf('/');
					seen.add(slash === -1 ? rest : rest.slice(0, slash));
				}
				return Array.from(seen).sort();
			},
		},
	};
	return session as unknown as FlueSession;
}

function normalize(path: string): string {
	if (path.startsWith('./')) return path.slice(2);
	return path;
}
