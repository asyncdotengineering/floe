# Providers

Every model Floe addresses goes through `provider/model-id` resolution. Flue auto-registers every provider Pi ships, so you can address any of them out of the box — just set the right env var and pass the model slug. No code change. Most users hit `openai`, `anthropic`, or `google` and don't realize the rest are sitting right there.

This page lists what's registered, the env var each provider reads for its API key, and a one-line example. If you've deployed Floe and your model isn't routing, this is the page to check.

## Address format

```ts
new Assistant({
  // ...
  model: '<provider>/<model-id>',
});
```

`provider` is one of the slugs in the table below. `model-id` is the provider's own naming for the specific model (e.g. `gpt-4.1-mini`, `claude-haiku-4-5-20251001`, `gemini-3.5-flash`). Pi's catalog has the full list of model ids per provider; the most common are documented at [pi-ai/dist/models](https://www.npmjs.com/package/@earendil-works/pi-ai).

## Built-in providers (no extra setup beyond the API key)

All of these are auto-registered by Flue at process start. Set the corresponding env var and address the model — no `registerProvider()` call needed.

| provider slug         | env var                          | example model id              | use case                                  |
| --------------------- | -------------------------------- | ----------------------------- | ----------------------------------------- |
| `openai`              | `OPENAI_API_KEY`                 | `gpt-4.1-mini`                | default for most chat                     |
| `anthropic`           | `ANTHROPIC_API_KEY`              | `claude-haiku-4-5-20251001`   | best for nuanced reasoning                |
| `google`              | `GEMINI_API_KEY`                 | `gemini-3.5-flash`            | fast + cheap, multilingual               |
| `google-vertex`       | `GOOGLE_CLOUD_API_KEY` (+ `GOOGLE_APPLICATION_CREDENTIALS` for ADC) | `gemini-3.5-flash` | GCP-hosted Gemini, enterprise tenants    |
| `azure-openai-responses` | `AZURE_OPENAI_API_KEY`         | `gpt-4`                       | Azure-hosted OpenAI, enterprise tenants  |
| `bedrock`             | AWS SDK creds (standard chain)   | `anthropic.claude-3-5-sonnet` | AWS-only deployments; Claude/Llama/Mistral on Bedrock |
| `mistral`             | `MISTRAL_API_KEY`                | `mistral-large-latest`        | Mistral direct                            |
| `groq`                | `GROQ_API_KEY`                   | `llama-4-maverick`            | fastest TTFT (~290 ms p50) for voice     |
| `cerebras`            | `CEREBRAS_API_KEY`               | `llama-3.3-70b`               | high throughput inference                 |
| `xai`                 | `XAI_API_KEY`                    | `grok-4`                      | xAI Grok models                           |
| `deepseek`            | `DEEPSEEK_API_KEY`               | `deepseek-v4-pro`             | strong reasoning, low cost                |
| `openrouter`          | `OPENROUTER_API_KEY`             | `meta-llama/llama-3.3-70b`    | unified gateway across providers          |
| `together`            | `TOGETHER_API_KEY`               | `meta-llama/Llama-3.3-70B`    | OSS model hosting                         |
| `fireworks`           | `FIREWORKS_API_KEY`              | `accounts/fireworks/models/llama-v3p3-70b-instruct` | OSS model hosting     |
| `huggingface`         | `HF_TOKEN`                       | varies                        | HuggingFace inference endpoints           |
| `moonshotai`          | `MOONSHOT_API_KEY`               | `kimi-k2.6`                   | Moonshot Kimi                             |
| `zai`                 | `ZAI_API_KEY`                    | `glm-5.1`                     | ZhipuAI GLM                               |
| `minimax`             | `MINIMAX_API_KEY`                | `minimax-m2.7`                | Minimax direct                            |
| `cloudflare-workers-ai` | `CLOUDFLARE_API_KEY`           | model ids in CF catalog       | edge inference via Workers AI (HTTP)      |
| `cloudflare-ai-gateway` | `CLOUDFLARE_API_KEY`           | via gateway routing           | unified gateway with cache + analytics    |
| `vercel-ai-gateway`   | `AI_GATEWAY_API_KEY`             | varies                        | Vercel's unified gateway                  |
| `github-copilot`      | `COPILOT_GITHUB_TOKEN`           | provider-specific             | Copilot subscription as LLM (OAuth)       |

OAuth-based providers (Anthropic personal subscriptions, GitHub Copilot personal) also support the OAuth flow via `pi-ai`'s OAuth machinery — usually overkill for a Floe service deployment; use the service API key for production.

## Cloudflare Workers AI via binding

For Cloudflare Workers, the AI binding is a different beast — it doesn't take an HTTP URL because the binding is captured at deploy time. Register it explicitly:

```ts
import { registerProvider } from '@flue/runtime/app';

// In your Worker entrypoint, after env is available:
registerProvider('workers-ai', {
  api: 'cloudflare-workers-ai',
  binding: env.AI,
  // gateway: { id: 'my-gateway' }, // optional AI Gateway
});

new Assistant({
  // ...
  model: 'workers-ai/@cf/meta/llama-3-8b-instruct',
});
```

## Custom endpoint (your own OpenAI-compatible proxy, enterprise gateway, etc.)

Alias any URL prefix to an existing api shape:

```ts
import { registerProvider } from '@flue/runtime/app';

registerProvider('mycorp', {
  api: 'openai-completions',  // reuse Pi's OpenAI wire handler
  baseUrl: 'https://llm.mycorp.internal/v1',
  apiKey: process.env.MYCORP_KEY,
  headers: { 'X-Tenant-Id': 'acme' },
});

new Assistant({
  // ...
  model: 'mycorp/gpt-4-equivalent',
});
```

If your endpoint uses a non-OpenAI wire format, also register the api handler:

```ts
import { registerApiProvider, registerProvider } from '@flue/runtime/app';

registerApiProvider({
  api: 'my-novel-api',
  stream: (model, ctx, opts) => { /* return AssistantMessageEventStream */ },
  streamSimple: (model, ctx, opts) => { /* same */ },
});
registerProvider('mycorp', {
  api: 'my-novel-api',
  baseUrl: 'https://mycorp.example/v1',
  apiKey: process.env.MYCORP_KEY,
});
```

## Per-model overrides

```ts
import { configureProvider } from '@flue/runtime/app';

configureProvider('mycorp', {
  contextWindow: 200_000,
  maxTokens: 8192,
  models: {
    'gpt-4-equivalent': { contextWindow: 1_000_000 },
  },
});
```

Patches the resolved Model. Useful when your endpoint's per-model defaults differ from Pi's catalog assumptions.

## Picking a provider

For most chat / support assistants:
- **GPT-4.1-mini** (`openai/gpt-4.1-mini`) — best all-around: ~290 ms TTFT, good multilingual, cheap.
- **Gemini 3.5 Flash** (`google/gemini-3.5-flash`) — fast, very cheap, good multilingual.
- **Groq Llama 4 Maverick** (`groq/llama-4-maverick`) — **fastest TTFT** at ~290 ms p50 — the right pick when voice latency is the bar.

Avoid for the conversational reply path:
- **Claude Sonnet** (`anthropic/claude-sonnet-4-...`) — ~1,400 ms TTFT. Excellent reasoning; use it inside Compute / Capture nodes where you need that quality, NOT on the streaming Reply path.
- **Thinking-mode models** (`o3`, `o3-mini`, gemini reasoning) — add 500-2000 ms before any user-visible token. Use for tool-augmented analysis, never for conversational TTFT.

For enterprise / regulated deployments:
- **AWS-only** → `bedrock/...`
- **Azure / regulated cloud** → `azure-openai-responses/...`
- **Air-gapped / on-prem** → register custom provider pointing at your internal vLLM/TGI/ollama endpoint via `registerProvider`

For edge / low-latency:
- **Cloudflare Workers** → `cloudflare-workers-ai/...` via binding
- **Groq** → `groq/...` for fastest provider TTFT

## Voice-specific notes

Voice platforms (Vapi, ElevenLabs, LiveKit) call Floe's `/v1/chat/completions` endpoint via the `openaiCompat` adapter. They don't care which underlying model Floe routes to — that's set per-Assistant via `model: '...'`. So you can serve voice traffic via `groq/llama-4-maverick` (fastest TTFT) while the wire stays OpenAI-shaped to the platform.

See `docs/LATENCY.md` for the 800 ms voice-to-voice budget breakdown and `docs/SUPPORT-BOT-BLUEPRINT.md` for the full assistant wiring.

## How addressing actually resolves

Flue's `resolveModel('provider/model-id')`:

1. Looks up `provider` in Flue's registered prefixes (set by `registerProvider`). If found → builds Model from registration metadata. Wins over Pi's catalog.
2. Otherwise → looks up via Pi's `getModel(provider, modelId)`. Pi's catalog covers every built-in.
3. Otherwise → throws `[flue] Unknown model "provider/model-id"`.

So custom `registerProvider` calls shadow built-ins. Useful when you want to point `'openai/gpt-4.1-mini'` at your own proxy instead of api.openai.com — register `'openai'` with your `baseUrl` and Floe routes there.
