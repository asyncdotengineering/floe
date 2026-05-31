# @floe/server-bootstrap

Single-call Node HTTP bootstrap for a Floe Assistant. Replaces the
60-90 LOC `server.ts` boilerplate every example used to carry.

## Install

```sh
pnpm add @floe/server-bootstrap @floe/runtime @floe/adapter-web @hono/node-server
```

## Usage

### Trivial (90% of cases)

```ts
import { runServer } from '@floe/server-bootstrap';
import assistant from './floe.config.ts';

await runServer(assistant);
```

That's the whole `server.ts`. The defaults:

- `port`: `process.env.PORT ?? 3000`
- `name`: `assistant.config.name`
- `metrics`: on in dev, off in `NODE_ENV=production`
- SIGINT/SIGTERM → graceful close → `process.exit(0)`
- `serverOptions.requestTimeout: 0` so SSE responses can outlive Node's 300s default

### OpenAI-compat mux (for voice / OpenAI SDK clients)

```ts
await runServer(assistant, { openaiCompat: true });
```

Mounts `/v1/chat/completions`, `/chat/completions`, `/v1/models`, `/models`, `/v1/embeddings`, `/embeddings`. Pass `{ assistants: [...] }` to expose multiple assistants.

### Async pre-listen lifecycle

For mock MCP servers, seeded databases, warm caches that need to be up before the Assistant boots:

```ts
await runServer(assistant, {
  beforeListen: async () => {
    const mock = await startMockMcp({ port: 4001 });
    return async () => mock.close(); // optional teardown — awaited on shutdown
  },
});
```

### Custom routes (debug, health checks)

```ts
await runServer(assistant, {
  routes: {
    '/health': () => new Response('ok'),
    '/debug/state': handleDebugState,
  },
});
```

Custom routes are matched FIRST (before openai-compat, before the Floe fetch).

## When NOT to use this

For exotic topologies — Bun, Cloudflare Workers, multiple assistants on bespoke paths, custom Hono middleware — drop back to `webAdapter` + raw `serve` from `@hono/node-server`. `runServer` is sugar, not a wall.
