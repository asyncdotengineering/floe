/**
 * Cloudflare Workers sandbox — `just-bash` + `InMemoryFs`.
 *
 * Lifts Flue's CLI-generated CF default sandbox setup verbatim:
 * `repo/flue/packages/cli/src/lib/build-plugin-cloudflare.ts:101-161`.
 * That exact shape is what the Flue CLI ships into every CF target by
 * default, so this is the canonical pattern.
 *
 * On CF Workers there is no host filesystem. `InMemoryFs` is a JS-backed
 * filesystem that survives for the DO container's lifetime.
 * `session.fs.readFile / readdir / stat / writeFile` all work against it.
 *
 * To serve markdown procedures, knowledge files, or skills from CF you:
 *   1. Bundle the markdown as JS string imports (esbuild text-loader)
 *   2. Pass them as `files` here OR write them via `session.fs.writeFile`
 *      at boot
 *
 * The default suppresses every Flue built-in tool (matching `localSandbox`)
 * so the model sees only your `defineTool()`'d tools.
 *
 * Cloudflare Workers only — do not import this from a Node bundle.
 */
import { bashFactoryToSessionEnv } from '@flue/runtime/internal';
import type { SandboxFactory } from '@flue/runtime';
import { Bash, InMemoryFs } from 'just-bash';

export interface CfBashSandboxOptions {
	/** Files to seed into the in-memory fs at boot. Map of relative path → content. */
	files?: Record<string, string>;
	/** Allow the LLM to make outbound HTTP calls from inside bash tools. Default true. */
	network?: boolean;
	/** Allow Flue's built-in bash/read/write/edit/grep/glob/task tools. Default false. */
	allowBuiltinTools?: boolean;
}

export function cfBashSandbox(opts: CfBashSandboxOptions = {}): SandboxFactory {
	const network = opts.network ?? true;
	const allowBuiltinTools = opts.allowBuiltinTools ?? false;

	const baseFactory = bashFactoryToSessionEnv(() => {
		const fs = new InMemoryFs();
		if (opts.files) {
			for (const [path, content] of Object.entries(opts.files)) {
				fs.writeFile(path, content);
			}
		}
		return new Bash({ fs, network: { dangerouslyAllowFullInternetAccess: network } });
	});

	// bashFactoryToSessionEnv returns a SessionEnv directly, not a SandboxFactory.
	// Wrap it in a factory so the AssistantConfig.sandbox contract holds.
	const factory: SandboxFactory = {
		createSessionEnv: async () => baseFactory,
		...(allowBuiltinTools ? {} : { tools: () => [] }),
	};
	return factory;
}
