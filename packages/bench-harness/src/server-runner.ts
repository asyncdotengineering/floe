/**
 * Spawn-and-ready helper for a per-model Floe server subprocess.
 *
 * Hides the bench-harness's noisiest piece: child_process.spawn,
 * readiness polling (40 × 200ms by default), and the SIGTERM →
 * SIGKILL escalation on shutdown. Returns when the server responds
 * to a `GET /` (or a custom `readyPath`).
 */
import { type ChildProcess, spawn } from 'node:child_process';

export interface ServerSpec {
	/** Working directory the command runs in. Defaults to `process.cwd()`. */
	cwd?: string;
	/**
	 * Command to spawn. First element is the binary, rest are args.
	 * Default: `['npx', 'tsx', 'server.ts']`.
	 */
	cmd?: [string, ...string[]];
	/** Port to bind. Threaded through as `PORT` env. */
	port: number;
	/** Additional env vars (e.g., `FLOE_MODEL`). */
	env?: Record<string, string>;
	/** Path the readiness probe `GET`s. Default `/`. */
	readyPath?: string;
	/** Total readiness timeout in ms. Default 8000. */
	readyTimeoutMs?: number;
	/**
	 * Forward subprocess stdio to the parent. Default `true` —
	 * extremely useful for debugging a bench that won't start.
	 */
	inheritStdio?: boolean;
}

export interface ServerHandle {
	port: number;
	baseUrl: string;
	stop(opts?: { graceMs?: number }): Promise<void>;
	/** Subprocess pid for debugging. May be undefined if the process died. */
	pid: number | undefined;
}

export async function startServer(spec: ServerSpec): Promise<ServerHandle> {
	const [bin, ...args] = spec.cmd ?? ['npx', 'tsx', 'server.ts'];
	if (!bin) throw new Error('[bench:startServer] empty cmd');
	const child: ChildProcess = spawn(bin, args, {
		cwd: spec.cwd ?? process.cwd(),
		env: { ...process.env, ...spec.env, PORT: String(spec.port) },
		stdio: spec.inheritStdio ?? true ? 'inherit' : 'ignore',
	});

	// If the child exits before we see readiness, surface that.
	interface ExitInfo { code: number | null; signal: NodeJS.Signals | null }
	let earlyExit: ExitInfo | null = null;
	child.once('exit', (code, signal) => {
		earlyExit = { code, signal };
	});
	const exitInfo = (): ExitInfo | null => earlyExit;

	const baseUrl = `http://localhost:${spec.port}`;
	const readyUrl = `${baseUrl}${spec.readyPath ?? '/'}`;
	const totalMs = spec.readyTimeoutMs ?? 8000;
	const intervalMs = 200;
	const maxAttempts = Math.ceil(totalMs / intervalMs);

	for (let i = 0; i < maxAttempts; i++) {
		const ex = exitInfo();
		if (ex) {
			throw new Error(
				`[bench:startServer] subprocess exited before ready: code=${ex.code} signal=${ex.signal}`,
			);
		}
		try {
			const r = await fetch(readyUrl, { method: 'GET' });
			// Any HTTP response means the server bound and is serving — even
			// a 404 on `/` proves the listener is up.
			if (r.ok || r.status === 404) {
				return makeHandle(child, spec.port, baseUrl);
			}
		} catch {
			// connection refused — server not up yet, keep polling.
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}

	// Timed out — kill the child + throw.
	try {
		child.kill('SIGKILL');
	} catch {
		// already dead
	}
	throw new Error(`[bench:startServer] readiness timeout after ${totalMs}ms (port ${spec.port})`);
}

function makeHandle(child: ChildProcess, port: number, baseUrl: string): ServerHandle {
	let stopped = false;
	return {
		port,
		baseUrl,
		pid: child.pid,
		async stop({ graceMs = 2000 } = {}) {
			if (stopped) return;
			stopped = true;
			if (child.exitCode !== null || child.signalCode) return;
			child.kill('SIGTERM');
			const exited = await Promise.race([
				new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs)),
			]);
			if (!exited) {
				try {
					child.kill('SIGKILL');
				} catch {
					// already dead
				}
			}
		},
	};
}
