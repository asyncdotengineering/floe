/**
 * Node-only local sandbox.
 *
 * Wraps Flue's `local()` factory from `@flue/runtime/node` with a tool
 * suppression. Flue's default sandbox attaches its built-in model-facing
 * tools (bash, read, write, edit, grep, glob, task) to every session.
 * For conversational agents those are confusing — the model has no
 * idea your bot is a customer-service flow and will happily `grep` the
 * filesystem instead of calling your `defineTool()`'d tools.
 *
 * This wrapper suppresses every Flue built-in (`tools: () => []`) while
 * preserving host-fs access for `session.fs.readFile` (procedures,
 * knowledge, skills).
 *
 * If you actually want the bash/file tools (you're building a coding
 * agent inside Floe), call `localSandbox({ allowBuiltinTools: true })`
 * and pass it as the Assistant's `sandbox`.
 *
 * Node only — do not import this from a Cloudflare Worker bundle.
 * Use `@floe/runtime/sandbox/cf-bash` on Cloudflare instead.
 */
import { local } from '@flue/runtime/node';
import type { SandboxFactory } from '@flue/runtime';

export interface LocalSandboxOptions {
	/** Allow Flue's built-in bash/read/write/edit/grep/glob/task tools through to the model. Default false. */
	allowBuiltinTools?: boolean;
}

export function localSandbox(opts: LocalSandboxOptions = {}): SandboxFactory {
	const base = local();
	if (opts.allowBuiltinTools) return base;
	return {
		createSessionEnv: base.createSessionEnv.bind(base),
		tools: () => [],
	};
}
