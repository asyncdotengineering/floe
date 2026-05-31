/**
 * Notion-shaped documentation mock. Pages have title, tags, last-edited
 * timestamp, body. Search is a simple lowercase substring match over
 * title + tags + body — enough for ops bots to pull runbooks and policy.
 */
import * as v from 'valibot';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { defineMockService, type MockService } from '../define-mock-service.ts';

export interface NotionPage {
	id: string;
	title: string;
	tags: string[];
	lastEdited: string;
	body: string;
}

const seedPath = resolvePath(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'seeds',
	'notion.json',
);

export interface NotionServiceOptions {
	seed?: NotionPage[] | string;
}

export async function notionService(
	opts: NotionServiceOptions = {},
): Promise<MockService<NotionPage>> {
	return defineMockService<NotionPage>({
		name: 'notion',
		seed: opts.seed ?? seedPath,
		operations: {
			search_pages: {
				description: 'Search the docs by query string. Case-insensitive substring match over title, tags, and body. Returns up to `limit` pages (default 5), each with id + title + tags + a 200-char body preview.',
				input: v.object({ query: v.string(), limit: v.optional(v.number()) }),
				handler: ({ query, limit }, store) => {
					const q = query.toLowerCase();
					const matches = store.list().filter((p) =>
						p.title.toLowerCase().includes(q) ||
						p.tags.some((t) => t.toLowerCase().includes(q)) ||
						p.body.toLowerCase().includes(q),
					);
					return matches.slice(0, limit ?? 5).map((p) => ({
						id: p.id,
						title: p.title,
						tags: p.tags,
						preview: p.body.slice(0, 200) + (p.body.length > 200 ? '…' : ''),
					}));
				},
			},
			get_page: {
				description: 'Fetch the full body of a page by id (e.g. page_staging_access).',
				input: v.object({ id: v.string() }),
				handler: ({ id }, store) => store.get(id),
			},
			list_by_tag: {
				description: 'List every page carrying a given tag. Returns id + title + lastEdited.',
				input: v.object({ tag: v.string() }),
				handler: ({ tag }, store) =>
					store
						.list()
						.filter((p) => p.tags.includes(tag))
						.map((p) => ({ id: p.id, title: p.title, lastEdited: p.lastEdited })),
			},
		},
	});
}
