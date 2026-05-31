/**
 * Node server. Mounts BOTH adapter surfaces on one Assistant:
 *   - /agents/web/<sessionId>   — `webAdapter` (Floe-aware chat UIs)
 *   - /v1/chat/completions      — `openaiCompat` (voice + OpenAI SDK)
 *
 * Both produce the same canonical OpenAI Chat Completions chunked SSE
 * wire. See `docs/LATENCY.md` for the streaming-architecture rationale.
 */
// Pi (the underlying LLM client) reads PI_CACHE_RETENTION to set the
// provider prompt-cache TTL. Default "short" = 5-min window; "long" = 1 h.
// Set BEFORE any Pi import so it's in process.env when the provider runs.
process.env.PI_CACHE_RETENTION ??= 'long';

import { runServer } from '@floe/server-bootstrap';
import supportAssistant from './floe.config.ts';

await runServer(supportAssistant, { openaiCompat: true });
