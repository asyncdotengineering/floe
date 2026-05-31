# @floe/state-libsql

Turso (libSQL) state stores for [`@floe/runtime`](../runtime).

## What

Three durable backends — drop-in implementations of Floe's state-store interfaces, persisted to a libSQL database (Turso or self-hosted):

- `libsqlAssistantStateStore({url, authToken})` — `AssistantStateStore` (per-session turn count, active flow, metrics)
- `libsqlSessionStore({url, authToken})` — Flue `SessionStore` (raw session entries)
- `libsqlTranscriptStore({url, authToken})` — `TranscriptStore` (user-renderable transcript powering `/history/*`)

All three use lazy `CREATE TABLE IF NOT EXISTS` on first call — no migration ceremony, no cold-start setup.

## When to use

- **Vercel / Lambda / any stateless deploy** where you need cross-cold-start continuity
- **Multi-instance Node** where in-memory stores would diverge across workers
- **Edge** — Turso is purpose-built for low-latency reads from global edge functions

For dev / single-worker Node / CF Durable Objects (which are single-writer per DO), the default in-memory stores from `@floe/runtime` are fine.

## Install

```bash
pnpm add @floe/state-libsql @libsql/client
```

## Use

```ts
import { Assistant } from '@floe/runtime';
import { localSandbox } from '@floe/runtime/sandbox/local';
import {
  libsqlAssistantStateStore,
  libsqlSessionStore,
  libsqlTranscriptStore,
} from '@floe/state-libsql';

const url = process.env.TURSO_URL!;
const authToken = process.env.TURSO_AUTH_TOKEN!;

export const ops = new Assistant({
  name: 'ops',
  systemPrompt: '...',
  model: 'anthropic/claude-sonnet-4-6',
  sandbox: localSandbox(),
  state: {
    sessionStore: libsqlSessionStore({ url, authToken }),
    assistantStateStore: libsqlAssistantStateStore({ url, authToken }),
    transcriptStore: libsqlTranscriptStore({ url, authToken }),
  },
});
```

Mount with `webAdapter({ assistant: ops })` from `@floe/adapter-web` (or any other adapter).

## License

MIT.
