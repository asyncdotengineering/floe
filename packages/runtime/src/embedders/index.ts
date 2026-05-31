export type { Embedder } from './types.ts';
export { FakeEmbedder, fakeEmbedder } from './fake.ts';
export type { FakeEmbedderOptions } from './fake.ts';
// Concrete embedders live behind their own subpaths so importing the
// barrel doesn't pull in CF-only or AI-SDK-only modules unnecessarily:
//   import { openaiEmbedder }     from '@floe/runtime/embedders/openai';      // HTTP, works everywhere
//   import { workersAiEmbedder }  from '@floe/runtime/embedders/workers-ai';  // CF binding
//   import { aiSdkEmbedder }      from '@floe/runtime/embedders/ai-sdk';      // wrap any Vercel AI SDK embedding model
