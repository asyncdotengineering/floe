/**
 * In-process reference implementation of MemoryService.
 *
 * Storage: nested Map<userId, Map<sessionId, MemoryEntry[]>>.
 * Search: BM25 over user-scoped entries (same tokenizer as the workspace
 * knowledge source — light Porter stem + stopword filter).
 *
 * Use this in dev / single-process deployments and small teams. For
 * production multi-instance, swap in a vector store-backed service
 * (Postgres+pgvector / Redis / LanceDB) keeping the same MemoryService
 * interface.
 */
import crypto from 'node:crypto';
import type {
	IngestSessionInput,
	IngestTurnInput,
	MemoryEntry,
	MemoryService,
	SearchMemoryRequest,
} from './types.ts';

const BM25_K1 = 1.5;
const BM25_B = 0.75;

const STOPWORDS = new Set([
	'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
	'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
	'should', 'may', 'might', 'can', 'and', 'or', 'but', 'not', 'no',
	'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as',
	'this', 'that', 'these', 'those', 'it', 'its', 'i', 'you', 'he', 'she',
	'we', 'they', 'them', 'their', 'his', 'her', 'me', 'us', 'my', 'your',
	'our', 'so', 'if', 'than', 'then', 'because', 'while', 'about', 'into',
]);

interface IndexedEntry {
	entry: MemoryEntry;
	tokens: string[];
	termFreq: Map<string, number>;
	length: number;
}

export class InMemoryMemoryService implements MemoryService {
	/** userId → sessionId → entries */
	private store = new Map<string, Map<string, IndexedEntry[]>>();

	async ingestTurn(input: IngestTurnInput): Promise<void> {
		const items: Array<{ author: 'user' | 'assistant'; content: string }> = [];
		if (input.userMessage?.trim()) {
			items.push({ author: 'user', content: input.userMessage.trim() });
		}
		if (input.assistantText?.trim()) {
			items.push({ author: 'assistant', content: input.assistantText.trim() });
		}
		if (items.length === 0) return;

		const userMap = this.userBucket(input.userId);
		const list = userMap.get(input.sessionId) ?? [];
		const now = new Date().toISOString();
		for (const it of items) {
			list.push(indexEntry({
				id: crypto.randomUUID(),
				sessionId: input.sessionId,
				userId: input.userId,
				content: it.content,
				author: it.author,
				metadata: input.metadata,
				createdAt: now,
			}));
		}
		userMap.set(input.sessionId, list);
	}

	async ingestSession(input: IngestSessionInput): Promise<void> {
		// Idempotent: replace any previous entries for this sessionId.
		const userMap = this.userBucket(input.userId);
		const fresh: IndexedEntry[] = [];
		for (const m of input.messages) {
			if (!m.content.trim()) continue;
			fresh.push(indexEntry({
				id: crypto.randomUUID(),
				sessionId: input.sessionId,
				userId: input.userId,
				content: m.content.trim(),
				author: m.role,
				metadata: input.metadata,
				createdAt: m.timestamp ?? new Date().toISOString(),
			}));
		}
		userMap.set(input.sessionId, fresh);
	}

	async search(req: SearchMemoryRequest): Promise<MemoryEntry[]> {
		const userMap = this.store.get(req.userId);
		if (!userMap) return [];

		const all: IndexedEntry[] = [];
		for (const list of userMap.values()) {
			for (const ie of list) {
				if (matchesFilter(ie.entry, req.filter)) all.push(ie);
			}
		}
		if (all.length === 0) return [];

		const qTokens = Array.from(new Set(tokenize(req.query)));
		if (qTokens.length === 0) return [];

		const totalDocs = all.length;
		const avgDocLength = all.reduce((acc, d) => acc + d.length, 0) / totalDocs;
		const df = new Map<string, number>();
		for (const d of all) {
			for (const term of new Set(d.tokens)) {
				df.set(term, (df.get(term) ?? 0) + 1);
			}
		}

		const scored: Array<{ ie: IndexedEntry; score: number }> = [];
		for (const d of all) {
			let s = 0;
			for (const term of qTokens) {
				const tf = d.termFreq.get(term);
				if (!tf) continue;
				const docFreq = df.get(term) ?? 0;
				const idf = Math.log((totalDocs - docFreq + 0.5) / (docFreq + 0.5) + 1);
				const norm = 1 - BM25_B + BM25_B * (d.length / (avgDocLength || 1));
				s += idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm));
			}
			if (s > 0) scored.push({ ie: d, score: s });
		}

		scored.sort((a, b) => b.score - a.score);
		const limit = req.limit ?? 10;
		const top = scored.slice(0, limit);
		if (top.length === 0) return [];
		const topScore = top[0]!.score;
		return top.map(({ ie, score }) => ({
			...ie.entry,
			score: topScore === 0 ? 0 : score / topScore,
		}));
	}

	async deleteForUser(userId: string): Promise<void> {
		this.store.delete(userId);
	}

	private userBucket(userId: string): Map<string, IndexedEntry[]> {
		let m = this.store.get(userId);
		if (!m) {
			m = new Map();
			this.store.set(userId, m);
		}
		return m;
	}
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function indexEntry(entry: MemoryEntry): IndexedEntry {
	const tokens = tokenize(entry.content);
	const termFreq = new Map<string, number>();
	for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
	return { entry, tokens, termFreq, length: tokens.length };
}

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^\w\s]/g, ' ')
		.split(/\s+/)
		.filter((t) => t.length > 1 && !STOPWORDS.has(t))
		.map(stem);
}

function stem(t: string): string {
	if (t.endsWith('ing') && t.length > 5) return t.slice(0, -3);
	if (t.endsWith('ed') && t.length > 4) return t.slice(0, -2);
	if (t.endsWith('s') && !t.endsWith('ss') && t.length > 3) return t.slice(0, -1);
	return t;
}

function matchesFilter(entry: MemoryEntry, filter?: Record<string, unknown>): boolean {
	if (!filter) return true;
	const md = entry.metadata ?? {};
	for (const [k, v] of Object.entries(filter)) {
		if (md[k] !== v) return false;
	}
	return true;
}
