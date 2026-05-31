/**
 * Thread store — localStorage-backed conversation registry.
 *
 * Each thread is its own Floe session: the `sessionId` is what we
 * pass to the openai-compat `user` field, which Floe maps to
 * `oai:<sessionId>` server-side. So selecting a thread = resuming
 * that exact Floe conversation.
 *
 * NO server persistence by design. The agent's memory layer (Floe's
 * `memory.preload`) is the durable source of facts about the user
 * across threads — the UI's thread list is the cosmetic shell.
 *
 * Storage layout in localStorage under `floe-studio:threads`:
 *   { threads: Thread[], activeId: string }
 */
import { nanoid } from 'nanoid';

export interface Thread {
	id: string;          // Same as the session id — pass-through to Floe
	title: string;
	createdAt: string;
	updatedAt: string;
	snippet: string;     // First user message, trimmed for the sidebar
}

const KEY = 'floe-studio:threads';
const ACTIVE_KEY = 'floe-studio:active-thread';

interface StorageShape {
	threads: Thread[];
}

function read(): StorageShape {
	if (typeof window === 'undefined') return { threads: [] };
	try {
		const raw = window.localStorage.getItem(KEY);
		if (!raw) return { threads: [] };
		const parsed = JSON.parse(raw) as StorageShape;
		return { threads: Array.isArray(parsed.threads) ? parsed.threads : [] };
	} catch {
		return { threads: [] };
	}
}

function write(s: StorageShape): void {
	if (typeof window === 'undefined') return;
	try {
		window.localStorage.setItem(KEY, JSON.stringify(s));
	} catch {
		// no-op (private mode, quota etc.)
	}
}

export function listThreads(): Thread[] {
	return read()
		.threads.slice()
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getActiveThreadId(): string | null {
	if (typeof window === 'undefined') return null;
	return window.localStorage.getItem(ACTIVE_KEY);
}

export function setActiveThreadId(id: string): void {
	if (typeof window === 'undefined') return;
	window.localStorage.setItem(ACTIVE_KEY, id);
}

export function newThread(): Thread {
	const now = new Date().toISOString();
	const id = `t_${nanoid(10)}`;
	const thread: Thread = {
		id,
		title: 'New chat',
		createdAt: now,
		updatedAt: now,
		snippet: '',
	};
	const s = read();
	s.threads.unshift(thread);
	write(s);
	setActiveThreadId(id);
	return thread;
}

export function deleteThread(id: string): void {
	const s = read();
	s.threads = s.threads.filter((t) => t.id !== id);
	write(s);
	if (getActiveThreadId() === id) {
		if (typeof window !== 'undefined') {
			window.localStorage.removeItem(ACTIVE_KEY);
		}
	}
}

/**
 * Update a thread after a user message — title derived from the first
 * user message if the thread is still "New chat".
 */
export function touchThreadWithUserMessage(id: string, userMessage: string): void {
	const s = read();
	const idx = s.threads.findIndex((t) => t.id === id);
	if (idx < 0) return;
	const t = s.threads[idx]!;
	const trimmed = userMessage.trim();
	const titleNew = t.title === 'New chat' && trimmed
		? trimmed.slice(0, 60) + (trimmed.length > 60 ? '…' : '')
		: t.title;
	const snippet = trimmed.slice(0, 120);
	s.threads[idx] = {
		...t,
		title: titleNew,
		snippet,
		updatedAt: new Date().toISOString(),
	};
	write(s);
}

export function searchThreads(query: string): Thread[] {
	const q = query.toLowerCase().trim();
	if (!q) return listThreads();
	return listThreads().filter(
		(t) =>
			t.title.toLowerCase().includes(q) ||
			t.snippet.toLowerCase().includes(q),
	);
}

/** Group threads by recency bucket for sidebar headers (T3-style). */
export function groupedByRecency(
	threads: Thread[],
): Array<{ bucket: 'Today' | 'Yesterday' | 'Last 7 days' | 'Older'; items: Thread[] }> {
	const now = Date.now();
	const day = 24 * 60 * 60 * 1000;
	const buckets = {
		Today: [] as Thread[],
		Yesterday: [] as Thread[],
		'Last 7 days': [] as Thread[],
		Older: [] as Thread[],
	};
	for (const t of threads) {
		const age = now - new Date(t.updatedAt).getTime();
		if (age < day) buckets['Today'].push(t);
		else if (age < 2 * day) buckets['Yesterday'].push(t);
		else if (age < 7 * day) buckets['Last 7 days'].push(t);
		else buckets['Older'].push(t);
	}
	return (['Today', 'Yesterday', 'Last 7 days', 'Older'] as const)
		.filter((b) => buckets[b].length > 0)
		.map((b) => ({ bucket: b, items: buckets[b] }));
}
