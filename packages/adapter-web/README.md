# @floe/adapter-web

Web (HTTP/JSON+SSE) adapter for `@floe/runtime`. The default channel for chat UIs and the transport voice harnesses dial into.

## Install

```sh
pnpm add @floe/adapter-web
```

## Usage

```ts
// assistant.ts
import { Assistant } from '@floe/runtime';
import { localSandbox } from '@floe/runtime/sandbox/local';

export const ops = new Assistant({
  name: 'ops',
  systemPrompt: '...',
  model: 'anthropic/claude-sonnet-4-6',
  sandbox: localSandbox(),
});

// server.ts
import { Hono } from 'hono';
import { webAdapter } from '@floe/adapter-web';
import { ops } from './assistant.ts';

const app = new Hono();
app.route('/', webAdapter({ assistant: ops }));
export default app;
```

Or, without Hono (Node / Cloudflare / Bun):

```ts
import { serve } from '@hono/node-server';
import { webAdapter } from '@floe/adapter-web';
import { ops } from './assistant.ts';

serve({ fetch: webAdapter({ assistant: ops }).fetch, port: 3000 });
```

### Inbound shape

`POST /agents/web/<sessionId>` with JSON `{"message": "..."}`. Optional `assistantName` and `metadata` fields on the body are forwarded onto the `user_text_sent` event.

### Voice overlay

Set header `X-Floe-Channel: voice` to flip the runtime's voice overlay (sequential tools, sentence boundaries, interim messages, transcription correction). A Pipecat process — or any voice harness — calls into the same web channel with this header.

## License

MIT.
