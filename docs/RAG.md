# RAG & Vector Stores in Floe

Floe ships a complete, pluggable retrieval-augmented-generation surface that works on **both Node and Cloudflare Workers**. Three things matter:

1. **Pre-LLM retrieval, not tool-call retrieval.** Floe injects retrieved chunks into the system prompt *before* the LLM call. We benchmarked the tool-call alternative (LLM decides to call `search_knowledge`) and it adds **+894ms to +2250ms TTFT** per turn vs pre-LLM. The interfaces in this doc are all pre-LLM.
2. **One `VectorStore` interface; many backends.** Pick a store that fits your deployment target (in-memory, SQLite, D1, Vectorize, Pgvector). Both `HybridKnowledgeSource` and `VectorStoreMemoryService` consume the same interface.
3. **One `Embedder` interface; everywhere.** `OpenAIEmbedder` (HTTP, works on Node + CF), `WorkersAIEmbedder` (CF binding), `FakeEmbedder` (deterministic, tests).

---

## When to use which knowledge source

| Source | Backed by | Best for | Cloudflare? |
|---|---|---|---|
| `workspaceBm25` | In-process BM25 over markdown | < 1k docs, lexical queries, lowest TTFT | ✓ |
| `hybridKnowledge` | BM25 + vector + optional reranker | Real production retrieval, semantic + lexical | ✓ (with CF-safe embedder + vector store) |

---

## Quick start — hybrid RAG

```ts
import { Assistant } from '@floe/runtime';
import { localSandbox } from '@floe/runtime/sandbox/local';
import { hybridKnowledge } from '@floe/runtime/knowledge/hybrid';
import { openaiEmbedder } from '@floe/runtime/embedders/openai';
import { InMemoryVectorStore } from '@floe/runtime/vectorstores';

const embedder = openaiEmbedder({
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'text-embedding-3-small',
  dimensions: 256, // custom dimensions supported on text-embedding-3-*
});

const vectorStore = new InMemoryVectorStore({ dimensions: 256 });

export const support = new Assistant({
  name: 'support',
  systemPrompt: '...',
  model: 'anthropic/claude-sonnet-4-6',
  sandbox: localSandbox(),
  knowledge: [
    hybridKnowledge({
      paths: ['knowledge/**/*.md'],
      embedder,
      vectorStore,
      chunkSize: 600,
      // strongSignal default: { minScore: 0.85, minGap: 0.15 }
    }),
  ],
});
```

That's the full wiring. On every user turn the orchestrator:

1. Runs BM25 over the indexed chunks.
2. **If the top BM25 hit scores ≥ 0.85 AND beats the runner-up by ≥ 0.15** — returns BM25 results, skips the rest. ~60% of queries land here.
3. Otherwise: embeds the query, queries the vector store, fuses BM25+vector via Reciprocal Rank Fusion (k=60).
4. Optionally reranks the top N candidates if you wired a `Reranker`.
5. Returns the top-K to the orchestrator, which injects them into the system prompt before the LLM call.

---

## Embedders

```ts
import { openaiEmbedder } from '@floe/runtime/embedders/openai';      // Node + CF
import { workersAiEmbedder } from '@floe/runtime/embedders/workers-ai'; // CF only
import { aiSdkEmbedder } from '@floe/runtime/embedders/ai-sdk';        // wrap any Vercel AI SDK embedding model
import { fakeEmbedder } from '@floe/runtime/embedders/fake';            // tests

// OpenAI — works anywhere fetch works
openaiEmbedder({ apiKey: '...', model: 'text-embedding-3-small', dimensions: 256 })

// Cloudflare Workers AI — no API key, free with Workers
workersAiEmbedder({ binding: env.AI, model: '@cf/baai/bge-base-en-v1.5' }) // 768 dims

// Azure / OpenRouter / Ollama via baseUrl
openaiEmbedder({ apiKey: '...', baseUrl: 'http://localhost:11434/v1' })

// Any AI-SDK embedding model — Cohere, Voyage, Mistral, Bedrock, Vertex, etc.
import { cohere } from '@ai-sdk/cohere';
aiSdkEmbedder({ model: cohere.embedding('embed-english-v3.0'), dimensions: 1024 })
```

**About AI SDK + Floe**: `aiSdkEmbedder` is the *optional* path — it lets you reuse any provider AI SDK supports without writing a new embedder. Floe's core embedders go direct (HTTP / CF binding) for two reasons: (1) smallest dep footprint — `ai` is a hefty runtime that you don't need to pull into a CF Worker just to call `/v1/embeddings`; (2) lowest type-coupling blast radius — when AI SDK bumps `EmbeddingModelV2 → EmbeddingModelV3` (as v7 does), code that nominally imports those types fails to typecheck even when the runtime shape is unchanged. Our `aiSdkEmbedder` adapter is **structurally typed over `doEmbed` + `maxEmbeddingsPerCall`** so it accepts both V2 and V3 models without a version pin.

Custom embedder? Implement the interface (3 fields):

```ts
import type { Embedder } from '@floe/runtime/embedders';

class MyEmbedder implements Embedder {
  readonly model = 'my-model';
  readonly dimensions = 768;
  async embed(texts: string[]): Promise<number[][]> { /* ... */ }
}
```

---

## Vector stores

Pick the one that matches your deployment target.

### `InMemoryVectorStore` — universal

```ts
import { InMemoryVectorStore } from '@floe/runtime/vectorstores';

const store = new InMemoryVectorStore({ dimensions: 1536 });
```

O(N) brute-force cosine. Fine for ≤10k vectors. Works on Node + CF + Deno + Bun.

### `D1VectorStore` — Cloudflare D1

```ts
import { d1VectorStore } from '@floe/runtime/vectorstores/d1';

// Inside a CF Worker:
const store = d1VectorStore({ db: env.DB, dimensions: 768 });
```

Same shape as SQLite (JSON-text + JS cosine). Use **alongside** Vectorize for very small workloads; for production scale on CF, use Vectorize directly.

### `VectorizeVectorStore` — Cloudflare Vectorize ★ CF production

```ts
import { vectorizeVectorStore } from '@floe/runtime/vectorstores/vectorize';

const store = vectorizeVectorStore({
  index: env.MY_INDEX,
  dimensions: 768,
  returnMetadata: 'all',
});
```

Native ANN, billions-of-vectors scale. Create the index ahead of time with `wrangler vectorize create`, bind in `wrangler.jsonc`. **Rich filter support** via Vectorize's native filter language (passed through as `args.filter`).

### `PgvectorStore` — Postgres + pgvector (Node, or CF via Hyperdrive)

```ts
import { Pool } from 'pg';
import { pgVectorStore } from '@floe/runtime/vectorstores/pgvector';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = pgVectorStore({ client: pool, dimensions: 1536 });
```

Real ANN via `<=>` cosine operator. Schema (extension + table + HNSW index) is created automatically the first time (`createSchema: false` to manage migrations yourself). Filter via JSONB `@>` containment.

---

## The hybrid pipeline in detail

`hybridKnowledge()` runs the pre-LLM retrieval pipeline. The flow:

```
user message
    ↓
BM25 over chunked markdown  ───────────┐
    ↓                                  │
[top-N candidates with scores]         │
    ↓                                  │ if top score ≥ minScore
strong-signal check                    │ AND gap ≥ minGap:
    ↓ (no)                             │ → return BM25
embed query (one Embedder call)        │
    ↓                                  │
vector store query (top-N)             │
    ↓                                  │
RRF fusion (k=60) of BM25 + vector     │
    ↓                                  │
top rerankCap candidates ──────────────┘
    ↓
optional Reranker.rerank()
    ↓
top-K returned to orchestrator
```

The strong-signal short-circuit is the single biggest perf win. Borrowed from qmd; defaults `{ minScore: 0.85, minGap: 0.15 }` mean clearly-lexical queries pay zero embed/vector cost. Disable with `strongSignal: false` if your queries are typically semantic.

### Tuning

```ts
hybridKnowledge({
  paths: ['docs/**/*.md'],
  embedder, vectorStore,
  chunkSize: 600,              // chars per chunk; smaller = more precise, larger = more context
  minChunkSize: 80,            // drop chunks shorter than this
  bm25CandidateLimit: 20,      // BM25 + vector top-N before fusion
  rerankCandidateLimit: 40,    // input cap to the reranker
  strongSignal: { minScore: 0.85, minGap: 0.15 },
  reranker: llmJudgeReranker({ session, model: 'google/gemini-3.1-flash-lite' }),
});
```

---

## Cross-session memory with the same primitives

`VectorStoreMemoryService` is a `MemoryService` implementation that wraps any (Embedder + VectorStore) pair. Every vector store backend becomes a memory backend for free.

```ts
import { createClient } from '@libsql/client';
import { vectorStoreMemoryService } from '@floe/runtime/memory';
import { openaiEmbedder } from '@floe/runtime/embedders/openai';
import { libSqlVectorStore } from '@floe/runtime/vectorstores/libsql';

const memoryService = vectorStoreMemoryService({
  embedder: openaiEmbedder({ apiKey: '...', dimensions: 256 }),
  vectorStore: libSqlVectorStore({
    client: createClient({ url: 'file:./memory.db' }),
    dimensions: 256,
  }),
});

new Floe({
  /* ... */
  defaults: {
    model: 'google/gemini-3.1-flash-lite',
    memory: { service: memoryService, preload: { maxTokens: 800 } },
  },
});
```

`userId` scoping is automatic — `ConversationConfig.resolveUserId(input)` decides whose memory the turn touches. Memory is silently skipped when there's no userId (privacy-safe default).

---

## Cloudflare-specific recipes

### Workers AI embedder + Vectorize store + Workers AI LLM

```ts
import { workersAiEmbedder } from '@floe/runtime/embedders/workers-ai';
import { vectorizeVectorStore } from '@floe/runtime/vectorstores/vectorize';
import { hybridKnowledge } from '@floe/runtime/knowledge/hybrid';

// inside an agent handler:
const knowledge = hybridKnowledge({
  paths: ['knowledge/**/*.md'],
  embedder: workersAiEmbedder({ binding: env.AI, model: '@cf/baai/bge-base-en-v1.5' }),
  vectorStore: vectorizeVectorStore({ index: env.KB_INDEX, dimensions: 768 }),
});

// model 'cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast' uses the same env.AI binding
```

Zero hosted dependencies. Fully on Cloudflare's edge.

### Turso (libSQL) + OpenAI embeddings — universal, durable, ANN-ready

```ts
import { createClient } from '@libsql/client/web'; // CF Workers
import { openaiEmbedder } from '@floe/runtime/embedders/openai';
import { libSqlVectorStore } from '@floe/runtime/vectorstores/libsql';

const knowledge = hybridKnowledge({
  paths: ['knowledge/**/*.md'],
  embedder: openaiEmbedder({ apiKey: env.OPENAI_API_KEY, dimensions: 1536 }),
  vectorStore: libSqlVectorStore({
    client: createClient({ url: env.TURSO_URL, authToken: env.TURSO_TOKEN }),
    dimensions: 1536,
  }),
});
```

Same `LibSqlVectorStore` works locally with `createClient({ url: 'file:./mem.db' })` from `@libsql/client` (Node). Migrate from local-dev → Turso-prod with one URL change.

### D1 + Workers AI for sub-1k-doc deployments

```ts
import { d1VectorStore } from '@floe/runtime/vectorstores/d1';

const knowledge = hybridKnowledge({
  paths: ['knowledge/**/*.md'],
  embedder: workersAiEmbedder({ binding: env.AI }),
  vectorStore: d1VectorStore({ db: env.DB, dimensions: 768 }),
});
```

For workloads small enough to fit in D1 (which has no native vector index — we do cosine in JS), this is the simplest CF setup. Migrate to Vectorize once you exceed ~10k vectors.

---

## Rerankers

Reranking improves quality on heads-up evals — at the cost of one extra LLM hop. **Don't enable it for voice agents** (TTFT-sensitive); fine for chat.

```ts
import { llmJudgeReranker } from '@floe/runtime/rerankers/llm-judge';

hybridKnowledge({
  /* ... */
  reranker: llmJudgeReranker({
    session,
    model: 'google/gemini-3.1-flash-lite',
    batchSize: 10,
  }),
});
```

Custom reranker? Implement the interface:

```ts
import type { Reranker } from '@floe/runtime/rerankers';

class CohereReranker implements Reranker {
  readonly name = 'cohere-rerank-v3';
  async rerank(args) { /* call Cohere API; return ids + 0..1 scores */ }
}
```

---

## Chunkers

`hybridKnowledge` and `workspaceBm25` both use the **heading-scored chunker** (ported from qmd's `BREAK_PATTERNS` + squared-distance decay). It prefers H1/H2/H3 boundaries over paragraph breaks, never splits inside code fences, and produces materially cleaner chunk boundaries than naive paragraph splitting.

Use it directly if you're chunking elsewhere:

```ts
import { chunkMarkdown, chunkMarkdownWithPositions } from '@floe/runtime/chunkers';

const chunks = chunkMarkdown(longMarkdown, {
  targetChars: 1200,
  overlapChars: 180,
  minChars: 80,
});
```

---

## Decision tree: which backend?

```
                       ┌── lowest TTFT, ≤1k docs, lexical-heavy   → workspaceBm25
                       │
                       ├── dev / single-process / tests           → InMemoryVectorStore
                       │
                       ├── one backend Node+CF+edge w/ persistence → LibSqlVectorStore (local file or Turso) ★
                       │
                       ├── massive scale on Cloudflare            → VectorizeVectorStore (native ANN)
                       │
                       ├── massive scale, existing Postgres       → PgvectorStore (HNSW index)
                       │
                       ├── existing Redis Stack / Upstash         → RedisVectorStore (native KNN)
                       │
                       ├── embedded Node DB with native ANN       → LanceDbVectorStore
                       │
                       └── small Cloudflare KB without Vectorize  → D1VectorStore (JS cosine)
```

Default recommendation for new Floe deployments: **`LibSqlVectorStore` + `OpenAIEmbedder`**. Same code Node → CF → edge → mobile, persists durably, native float32 vector ops in the DB.

### `RedisVectorStore` — Node + Cloudflare (via Upstash), real ANN

```ts
import Redis from 'ioredis';
import { redisVectorStore } from '@floe/runtime/vectorstores/redis';

const redis = new Redis(process.env.REDIS_URL!);
const store = redisVectorStore({
  client: { command: (args) => redis.callBuffer(String(args[0]), ...args.slice(1)) },
  dimensions: 1536,
  algorithm: 'HNSW',
});
```

Backed by **Redis Search** (Redis Stack / Redis ≥ 8) native `FT.CREATE VECTOR HNSW` + `FT.SEARCH ... KNN`. Real ANN; not JS cosine. Distance is cosine, normalized to similarity ∈ [0, 1] for RRF composition.

Client-agnostic via a single `command(args)` runner — wrap any Redis library:

```ts
// node-redis v4
{ command: (args) => nodeRedis.sendCommand(args as string[]) }

// @upstash/redis (HTTP, works on CF Workers)
{ command: (args) => upstash.send(String(args[0]), args.slice(1)) }
```

Choose Redis when:
- You already run Redis Stack / Upstash for caching
- You want a shared vector store across multi-instance workers without a separate DB
- You're on Cloudflare and don't want Vectorize (Upstash + Redis Search runs over HTTP)

### `LanceDbVectorStore` — Node, embedded ANN

```ts
import * as lancedb from '@lancedb/lancedb';
import { lanceDbVectorStore } from '@floe/runtime/vectorstores/lancedb';

const db = await lancedb.connect('./lance');
let table;
try { table = await db.openTable('floe_vectors'); }
catch { table = await db.createTable('floe_vectors', [
  { id: 'seed', vector: new Array(1536).fill(0), text: '', metadata: '{}' }
]); }

const store = lanceDbVectorStore({ table, dimensions: 1536, distance: 'cosine' });
```

LanceDB = embedded vector DB (think "SQLite for vectors"), Apache Arrow under the hood, native HNSW/IVF indexes via the Rust core. **Node-only** — CF / Workers should use `VectorizeVectorStore` or `LibSqlVectorStore` instead.

Choose LanceDB when:
- You want a single-file embedded DB with real ANN (not JS cosine)
- You're on Node and OK with a Rust native addon
- You expect >100k vectors and SQLite-cosine is too slow

Supports cosine / l2 / dot distance — Floe normalizes all to [0, 1] similarity so it composes with hybrid RAG's RRF fusion.

---

## Performance notes

From our N=10 benchmark (`examples/streaming-bot/test/bench.test.ts`):

- `workspaceBm25` (lexical only): **~590ms p50** TTFT including LLM call (gemini-3.1-flash-lite).
- `hybridKnowledge` with strong-signal short-circuit + OpenAI embedder: **~600-700ms p50** when BM25 strong-signals; **~1100-1500ms p50** when vector path fires (extra embed call).
- `LLMJudgeReranker` adds ~1-2s per turn (one LLM rerank call). Skip for voice.

All numbers Sydney→Google/OpenAI. Your latency depends on geography.

---

## What's NOT shipped

- Native `sqlite-vec` extension wiring — `LibSqlVectorStore` covers the "SQLite with real vectors" use case better. Use Pgvector or Vectorize beyond 10k vectors if you need full ANN.
- Local GGUF embedding model (qmd's choice). Use OpenAI HTTP or Workers AI.
- MCP tool-call retrieval surface. Pre-LLM only — benchmarked +1-2s TTFT cost.
- Hosted reranker SDKs (Cohere / Voyage). Ship as 30 LOC user code; document above.
- `vector_top_k` + `libsql_vector_idx` ANN paths on `LibSqlVectorStore` — v1 uses native `ORDER BY vector_distance_cos`. Add opt-in ANN when scale demands.
