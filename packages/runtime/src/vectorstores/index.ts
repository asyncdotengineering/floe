export type {
	VectorItem,
	VectorMatch,
	VectorQuery,
	VectorStore,
} from './types.ts';
export { cosineSimilarity, matchesFilter } from './types.ts';
export { InMemoryVectorStore, inMemoryVectorStore } from './in-memory.ts';
export type { InMemoryVectorStoreOptions } from './in-memory.ts';
// Backend-specific stores live behind their own subpaths because they
// require platform-specific deps:
//   import { sqliteVectorStore }    from '@floe/runtime/vectorstores/sqlite';     // Node
//   import { d1VectorStore }        from '@floe/runtime/vectorstores/d1';        // CF
//   import { vectorizeVectorStore } from '@floe/runtime/vectorstores/vectorize'; // CF
//   import { pgVectorStore }        from '@floe/runtime/vectorstores/pgvector';  // Node
//   import { libSqlVectorStore }    from '@floe/runtime/vectorstores/libsql';    // Node + CF + edge (Turso / local libSQL)
//   import { redisVectorStore }     from '@floe/runtime/vectorstores/redis';     // Node + CF (Upstash) — Redis Search KNN
//   import { lanceDbVectorStore }   from '@floe/runtime/vectorstores/lancedb';   // Node — embedded LanceDB with native ANN
