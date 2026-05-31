/**
 * Product catalog — libSQL (Turso) database, single durable file.
 *
 * Two tables live in the same DB file:
 *   - `products`        — relational catalog rows (sku, name, price, stock, etc.)
 *   - `floe_vectors`    — managed by Floe's `LibSqlVectorStore` (F32_BLOB embeddings, native cosine)
 *
 * Why libSQL (not better-sqlite3):
 *   - Works on Node + Cloudflare Workers + edge runtimes — same client
 *   - Native vector primitives (`F32_BLOB(N)`, `vector_distance_cos`) — distance in DB, not JS
 *   - Same file → Turso cloud with one URL change (`libsql://...turso.io`)
 *   - No native compile step on `npm install`
 *
 * Hybrid search fuses:
 *   - SQL lexical scoring (LIKE over name + tags + description)
 *   - Cosine similarity via `LibSqlVectorStore.query()`
 *   - Reciprocal Rank Fusion (k=60) for the combine
 *
 * Filters (category / maxPriceUsd / inStock) run as SQL `WHERE`
 * predicates BEFORE the rank — keeps the candidate pool small and fast.
 */
import { createClient, type Client as LibsqlClient } from '@libsql/client';
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Embedder } from '@floe/runtime/embedders';
import { libSqlVectorStore, type LibSqlVectorStore } from '@floe/runtime/vectorstores/libsql';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_DB = resolve(__dirname, '..', 'catalog.db');

/**
 * Vercel serverless functions have a READ-ONLY filesystem at the bundle
 * root (/var/task). libsql opens connections in read-write mode, so we
 * copy the bundled DB to /tmp once on cold start. /tmp is the only
 * writeable location in serverless Node functions.
 *
 * No effect locally (process.env.VERCEL is unset).
 */
function resolveDbPath(): string {
	if (process.env.VERCEL === '1' || process.env.LAMBDA_TASK_ROOT) {
		const tmp = '/tmp/catalog.db';
		// Try the bundled path next to this file; if not there, the seed
		// runs from scratch into /tmp.
		const candidates = [BUNDLED_DB, resolve(process.cwd(), 'catalog.db')];
		const src = candidates.find((p) => existsSync(p));
		if (!existsSync(tmp) && src) {
			copyFileSync(src, tmp);
			console.log(`[catalog] copied ${src} → ${tmp} (Vercel cold-start)`);
		} else if (!existsSync(tmp)) {
			console.log(`[catalog] no pre-built DB found; will seed fresh into ${tmp}`);
		}
		return tmp;
	}
	return BUNDLED_DB;
}

const DB_URL = process.env.TURSO_URL ?? `file:${resolveDbPath()}`;
const DB_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;

export interface Product {
	sku: string;
	name: string;
	category: 'jacket' | 'sneaker' | 'bag' | 'top' | 'accessory';
	priceUsd: number;
	description: string;
	tags: string[];
	sizesAvailable: string[];
	colorsAvailable: string[];
	stockBySize: Record<string, number>;
	createdAt: string;
}

const SEED_PRODUCTS: Product[] = [
	{
		sku: 'ATL-DJ-001',
		name: 'Atlas Down Jacket',
		category: 'jacket',
		priceUsd: 189,
		description:
			'Packable mid-weight down jacket for shoulder-season conditions. Water-resistant DWR finish, adjustable hood, hand-warmer pockets. 80% recycled nylon shell, 800-fill responsible down. Compresses into chest pocket.',
		tags: ['warm', 'packable', 'recycled', 'hiking', 'commuting', 'fall', 'winter', 'down', 'jacket'],
		sizesAvailable: ['XS', 'S', 'M', 'L', 'XL', 'XXL'],
		colorsAvailable: ['Slate', 'Forest', 'Sand'],
		stockBySize: { XS: 8, S: 14, M: 22, L: 19, XL: 11, XXL: 4 },
		createdAt: '2025-08-12',
	},
	{
		sku: 'HRZ-SN-002',
		name: 'Horizon Daily Sneaker',
		category: 'sneaker',
		priceUsd: 128,
		description:
			'All-day everyday sneaker with cushioned EVA midsole and breathable lining. Premium leather upper, rubber outsole. Designed for walking 5+ miles comfortably. Standard width only.',
		tags: ['casual', 'walking', 'leather', 'sneaker', 'everyday', 'office', 'travel'],
		sizesAvailable: ['6', '7', '8', '9', '10', '11', '12', '13'],
		colorsAvailable: ['Off-white', 'Black', 'Olive'],
		stockBySize: { '6': 3, '7': 7, '8': 15, '9': 22, '10': 24, '11': 18, '12': 9, '13': 2 },
		createdAt: '2025-10-04',
	},
	{
		sku: 'MRD-TT-003',
		name: 'Meridian Tote',
		category: 'bag',
		priceUsd: 74,
		description:
			'Structured everyday tote with one zipped interior pocket and two slip pockets. Magnetic snap, single shoulder strap, fits a 15" laptop. Vegetable-tanned leather, brass hardware, cotton-lined interior.',
		tags: ['leather', 'tote', 'bag', 'laptop', 'commute', 'work', 'everyday'],
		sizesAvailable: ['one-size'],
		colorsAvailable: ['Black', 'Camel', 'Olive'],
		stockBySize: { 'one-size': 31 },
		createdAt: '2025-11-19',
	},
	{
		sku: 'ECH-TS-004',
		name: 'Echo Pima T-Shirt',
		category: 'top',
		priceUsd: 42,
		description:
			'Relaxed-fit Peruvian pima cotton crewneck — drapes rather than clings. Pre-washed, single-stitched neck. Sustainable cotton from a single Peruvian co-op. Size down for a slim fit.',
		tags: ['cotton', 'tshirt', 'top', 'relaxed', 'pima', 'sustainable', 'layering', 'daily'],
		sizesAvailable: ['XS', 'S', 'M', 'L', 'XL'],
		colorsAvailable: ['White', 'Black', 'Heather Grey', 'Sage', 'Sand'],
		stockBySize: { XS: 24, S: 42, M: 58, L: 47, XL: 21 },
		createdAt: '2025-09-08',
	},
	{
		sku: 'AUR-SF-005',
		name: 'Aurora Merino Scarf',
		category: 'accessory',
		priceUsd: 58,
		description:
			'Medium-weight 78×12" scarf in dense ribbed knit. 100% Mongolian merino wool. Drapes well without pilling, hand-finished fringe. Great gift and layering piece below 10°C.',
		tags: ['wool', 'scarf', 'merino', 'accessory', 'gift', 'winter', 'cold'],
		sizesAvailable: ['one-size'],
		colorsAvailable: ['Charcoal', 'Cream', 'Burgundy', 'Forest', 'Camel'],
		stockBySize: { 'one-size': 26 },
		createdAt: '2025-12-01',
	},
];

type InValue = string | number | null | Uint8Array | ArrayBuffer | bigint;

const EMBEDDER_DIMS = 256;

export interface CatalogHandle {
	client: LibsqlClient;
	embedder: Embedder;
	vectorStore: LibSqlVectorStore;
	getProduct(sku: string): Promise<Product | undefined>;
	listProducts(): Promise<Product[]>;
	indexEmbeddings(): Promise<void>;
	hybridSearch(args: { query: string; limit?: number; category?: Product['category']; maxPriceUsd?: number; inStock?: boolean }): Promise<Array<Product & { score: number }>>;
	close(): void;
}

export async function openCatalog(embedder: Embedder): Promise<CatalogHandle> {
	if (embedder.dimensions !== EMBEDDER_DIMS) {
		throw new Error(`[catalog] embedder dimensions ${embedder.dimensions} ≠ expected ${EMBEDDER_DIMS}. Pass openaiEmbedder({...dimensions: ${EMBEDDER_DIMS}}).`);
	}
	const client = createClient({
		url: DB_URL,
		...(DB_AUTH_TOKEN ? { authToken: DB_AUTH_TOKEN } : {}),
	});

	await client.execute(`CREATE TABLE IF NOT EXISTS products (
		sku TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		category TEXT NOT NULL,
		price_usd REAL NOT NULL,
		description TEXT NOT NULL,
		tags TEXT NOT NULL,
		sizes_available TEXT NOT NULL,
		colors_available TEXT NOT NULL,
		stock_by_size TEXT NOT NULL,
		created_at TEXT NOT NULL
	);`);
	await client.execute(`CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);`);
	await client.execute(`CREATE INDEX IF NOT EXISTS idx_products_price ON products(price_usd);`);

	const countRes = await client.execute(`SELECT COUNT(*) AS n FROM products`);
	const seedCount = Number((countRes.rows[0] as Record<string, unknown> | undefined)?.n ?? 0);
	if (seedCount === 0) {
		const stmts = SEED_PRODUCTS.map((r) => ({
			sql: `INSERT INTO products (sku, name, category, price_usd, description, tags, sizes_available, colors_available, stock_by_size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			args: [
				r.sku,
				r.name,
				r.category,
				r.priceUsd,
				r.description,
				JSON.stringify(r.tags),
				JSON.stringify(r.sizesAvailable),
				JSON.stringify(r.colorsAvailable),
				JSON.stringify(r.stockBySize),
				r.createdAt,
			] as InValue[],
		}));
		await client.batch(stmts, 'write');
	}

	const vectorStore = libSqlVectorStore({ client, dimensions: EMBEDDER_DIMS, tableName: 'product_vectors' });
	let indexed = false;

	function rowToProduct(row: Record<string, unknown>): Product {
		return {
			sku: String(row.sku),
			name: String(row.name),
			category: String(row.category) as Product['category'],
			priceUsd: Number(row.price_usd),
			description: String(row.description),
			tags: JSON.parse(String(row.tags)) as string[],
			sizesAvailable: JSON.parse(String(row.sizes_available)) as string[],
			colorsAvailable: JSON.parse(String(row.colors_available)) as string[],
			stockBySize: JSON.parse(String(row.stock_by_size)) as Record<string, number>,
			createdAt: String(row.created_at),
		};
	}

	const handle: CatalogHandle = {
		client,
		embedder,
		vectorStore,
		async getProduct(sku) {
			const res = await client.execute({ sql: `SELECT * FROM products WHERE sku = ?`, args: [sku] });
			const row = res.rows[0];
			return row ? rowToProduct(row as Record<string, unknown>) : undefined;
		},
		async listProducts() {
			const res = await client.execute(`SELECT * FROM products ORDER BY sku`);
			return res.rows.map((r) => rowToProduct(r as Record<string, unknown>));
		},
		async indexEmbeddings() {
			if (indexed) return;
			const products = await handle.listProducts();
			const docs = products.map((p) => `${p.name}. ${p.tags.join(' ')}. ${p.description}`);
			const embeddings = await embedder.embed(docs);
			await vectorStore.upsert(
				products.map((p, i) => ({
					id: p.sku,
					embedding: embeddings[i]!,
					text: p.name,
					metadata: { sku: p.sku, category: p.category, priceUsd: p.priceUsd },
				})),
			);
			indexed = true;
		},
		async hybridSearch(args) {
			// 1. SQL-side filter via WHERE.
			const where: string[] = [];
			const params: InValue[] = [];
			if (args.category) { where.push(`category = ?`); params.push(args.category); }
			if (args.maxPriceUsd !== undefined) { where.push(`price_usd <= ?`); params.push(args.maxPriceUsd); }
			const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
			const res = await client.execute({ sql: `SELECT * FROM products ${whereSql}`, args: params });
			const filtered = res.rows.map((r) => rowToProduct(r as Record<string, unknown>));
			let candidates = args.inStock
				? filtered.filter((p) => Object.values(p.stockBySize).some((c) => c > 0))
				: filtered;
			if (candidates.length === 0) return [];

			// 2. Lexical scoring (simple bag-of-words overlap over name + tags + description).
			const queryTokens = tokenize(args.query);
			const lexScores = new Map<string, number>();
			for (const p of candidates) {
				const docTokens = tokenize(`${p.name} ${p.tags.join(' ')} ${p.description}`);
				let s = 0;
				for (const qt of queryTokens) if (docTokens.includes(qt)) s += 1;
				if (s > 0) lexScores.set(p.sku, s / Math.max(queryTokens.length, 1));
			}

			// 3. Vector scoring (only if embeddings have been indexed).
			const vecScores = new Map<string, number>();
			if (indexed) {
				const [queryEmbedding] = await embedder.embed([args.query]);
				if (queryEmbedding) {
					const candidateSet = new Set(candidates.map((p) => p.sku));
					const matches = await vectorStore.query({ embedding: queryEmbedding, limit: candidates.length * 2 });
					for (const m of matches) if (candidateSet.has(m.id)) vecScores.set(m.id, m.score);
				}
			}

			// 4. RRF fusion.
			const RRF_K = 60;
			const rankByScoreDesc = (m: Map<string, number>): string[] =>
				Array.from(m.entries()).sort((a, b) => b[1] - a[1]).map(([sku]) => sku);
			const lexRanking = rankByScoreDesc(lexScores);
			const vecRanking = rankByScoreDesc(vecScores);
			const fused = new Map<string, number>();
			for (let i = 0; i < lexRanking.length; i++) {
				const sku = lexRanking[i]!;
				fused.set(sku, (fused.get(sku) ?? 0) + 1 / (RRF_K + i + 1));
			}
			for (let i = 0; i < vecRanking.length; i++) {
				const sku = vecRanking[i]!;
				fused.set(sku, (fused.get(sku) ?? 0) + 1 / (RRF_K + i + 1));
			}
			const ranked = Array.from(fused.entries()).sort((a, b) => b[1] - a[1]);
			if (ranked.length === 0) return [];
			const topScore = ranked[0]![1];
			const limit = args.limit ?? 5;
			return ranked.slice(0, limit).map(([sku, raw]) => {
				const product = candidates.find((p) => p.sku === sku)!;
				return { ...product, score: topScore === 0 ? 0 : raw / topScore };
			});
		},
		close() {
			client.close();
		},
	};
	return handle;
}

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^\w\s]/g, ' ')
		.split(/\s+/)
		.filter((t) => t.length > 1);
}
