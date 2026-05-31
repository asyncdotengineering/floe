# @floe/adapter-slack

Slack channel adapter for Floe Assistants. Verifies signed Events API
webhooks, routes DMs + `@mentions` into Floe conversations, posts the
assistant's reply via the Slack Web API.

## Install

```sh
pnpm add @floe/adapter-slack
```

## Usage

```ts
import { runServer } from '@floe/server-bootstrap';
import { slackAdapter } from '@floe/adapter-slack';
import { ops } from './assistant.ts';

await runServer(ops, {
  routes: {
    '/slack/events': slackAdapter({
      assistant: ops,
      signingSecret: process.env.SLACK_SIGNING_SECRET!,
      botToken: process.env.SLACK_BOT_TOKEN!,
    }),
  },
});
```

## Slack app setup

In [api.slack.com/apps](https://api.slack.com/apps):

1. **Event Subscriptions** → Request URL: `https://your-host/slack/events`
   (Slack does a `url_verification` handshake — the adapter handles it.)
2. **Subscribe to bot events**: `app_mention`, `message.im`
3. **Bot Token Scopes**: `app_mentions:read`, `chat:write`, `im:history`, `im:read`
4. **Install to workspace** → grab the Signing Secret + Bot Token (`xoxb-…`).

## How sessions are keyed

By default: `<teamId>:<channelId>` — one Floe session per Slack channel.
Every message in that channel threads into the same conversation.

For per-thread sessions instead, pass `sessionScope: 'thread'` — each
Slack thread root opens a fresh conversation.

## What the adapter handles

- HMAC-SHA256 signature verification (with replay-window protection)
- `url_verification` handshake
- Filtering bot-authored messages (no echo loops) + non-message subtypes
- Stripping `<@U…>` mention tokens before the LLM sees the text
- 200-in-3-seconds Slack requirement (turn runs async after ack)
- Posting the reply (threaded under the original message)

## What you bring

- The Slack app setup (signing secret + bot token + scopes)
- Your Floe Assistant config

## Tests

```sh
pnpm --filter @floe/adapter-slack test
```
