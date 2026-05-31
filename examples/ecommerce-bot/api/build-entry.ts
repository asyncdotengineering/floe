import { resolve } from 'node:path';

// Workspace cwd is plumbed through Flue's canonical init({cwd}) API in
// the orchestrator (packages/runtime/src/orchestrator/prepare-turn.ts).
// `convo.configDir` propagates to `harness.init({cwd})` →
// `sandbox.createSessionEnv({cwd})` → `createCwdSessionEnv` wrap.
//
// The subtlety: esbuild bundles floe.config.ts INTO this file
// (api/handler.mjs). So `import.meta.url` inside floe.config evaluates
// to the bundle path (api/), not the original config-file path. We
// stash the true project root here (one level up from this api/ file)
// in a process env var BEFORE the dynamic import, and floe.config reads
// it as the authoritative configDir source.
process.env.FLOE_WORKSPACE_ROOT = resolve(import.meta.dirname, '..');

// Default provider prompt-cache TTL to 1 h (Pi default is 5 min). The
// static system prompt + persona + tool descriptions are identical every
// turn; we want them cached across requests for the same Lambda. Set
// BEFORE any Pi import lands. See docs/LATENCY.md.
process.env.PI_CACHE_RETENTION ??= 'long';

const { default: supportAssistant } = await import('../floe.config.js');
const { webAdapter } = await import('@floe/adapter-web');
const { openaiCompat } = await import('@floe/runtime/openai-compat');

// Two surfaces, ONE canonical wire (OpenAI Chat Completions chunked SSE):
//   - /agents/web/<sessionId>  (webAdapter — for Floe-aware chat UIs)
//   - /v1/chat/completions     (openaiCompat — for voice platforms +
//                               OpenAI SDK clients; same wire as above)
// Both adapters share the same FloeApp under the hood (lazy-cached on
// the Assistant), so wiring both is free. See `docs/LATENCY.md`.
const floe = webAdapter({ assistant: supportAssistant });
const openai = openaiCompat({ assistants: [supportAssistant] });

export default {
	async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const originalPath = url.searchParams.get('__path');
		if (originalPath) {
			url.pathname = `/${originalPath}`;
			url.searchParams.delete('__path');
		}
		// Route by URL prefix. openaiCompat owns /v1/* and bare /chat/completions
		// and /models; everything else (including /agents/*) goes to webAdapter.
		const p = url.pathname;
		const isOpenAIRoute =
			p === '/v1/chat/completions' ||
			p === '/chat/completions' ||
			p === '/v1/models' ||
			p === '/models' ||
			p === '/v1/embeddings' ||
			p === '/embeddings';
		const handler = isOpenAIRoute ? openai : floe.fetch;
		return handler(new Request(url, req));
	},
};
