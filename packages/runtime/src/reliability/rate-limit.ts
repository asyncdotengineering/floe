/**
 * In-process token-bucket rate limiter. Fine for single-process Node;
 * for multi-instance / Cloudflare, use `kvRateLimit` with a KV-shaped
 * backend (CF KV, Upstash, Redis, etc.) — the same RateLimiter interface.
 */
import type { RateLimitDecision, RateLimiter, RateLimiterContext } from './types.ts';

export interface TokenBucketRateLimitOptions {
	/** Maximum tokens in the bucket — bursts up to this. */
	capacity: number;
	/** Tokens refilled per second. */
	refillPerSec: number;
	/** Key for the bucket — derived from the turn context. */
	keyBy?: (ctx: RateLimiterContext) => string;
	/** Optional name for telemetry. */
	name?: string;
}

interface Bucket {
	tokens: number;
	lastRefillMs: number;
}

export class TokenBucketRateLimit implements RateLimiter {
	readonly name: string;
	private readonly capacity: number;
	private readonly refillPerSec: number;
	private readonly keyBy: (ctx: RateLimiterContext) => string;
	private readonly buckets = new Map<string, Bucket>();

	constructor(opts: TokenBucketRateLimitOptions) {
		if (opts.capacity <= 0) throw new Error('[TokenBucketRateLimit] capacity must be > 0');
		if (opts.refillPerSec <= 0) throw new Error('[TokenBucketRateLimit] refillPerSec must be > 0');
		this.capacity = opts.capacity;
		this.refillPerSec = opts.refillPerSec;
		this.name = opts.name ?? 'token-bucket';
		this.keyBy = opts.keyBy ?? defaultKey;
	}

	check(ctx: RateLimiterContext): RateLimitDecision {
		const key = this.keyBy(ctx);
		const now = Date.now();
		const existing = this.buckets.get(key);
		let bucket: Bucket;
		if (!existing) {
			bucket = { tokens: this.capacity, lastRefillMs: now };
			this.buckets.set(key, bucket);
		} else {
			bucket = existing;
			const elapsedSec = (now - bucket.lastRefillMs) / 1000;
			bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSec * this.refillPerSec);
			bucket.lastRefillMs = now;
		}
		if (bucket.tokens >= 1) {
			bucket.tokens -= 1;
			return { allow: true, metadata: { key, remaining: Math.floor(bucket.tokens) } };
		}
		const retryAfterSeconds = Math.ceil((1 - bucket.tokens) / this.refillPerSec);
		return {
			allow: false,
			reason: `Rate limit exceeded for key=${key}. Retry in ~${retryAfterSeconds}s.`,
			retryAfterSeconds,
			metadata: { key, remaining: 0 },
		};
	}

	/** Test helper — wipe state. */
	reset(): void {
		this.buckets.clear();
	}
}

function defaultKey(ctx: RateLimiterContext): string {
	if (ctx.userId) return `user:${ctx.userId}`;
	return `conv:${ctx.conversation}`;
}

export function tokenBucketRateLimit(opts: TokenBucketRateLimitOptions): TokenBucketRateLimit {
	return new TokenBucketRateLimit(opts);
}

/**
 * KV-backed rate limiter. The KV adapter is structural — works with
 * Cloudflare KV, Upstash Redis HTTP, Vercel KV, anything exposing
 * get/put with TTL.
 *
 * Uses a coarse minute-window counter (not pure token-bucket) — simpler
 * to implement on KV stores without atomic decrement support. Trade-off:
 * bursts at minute boundaries. For strict isolation use a dedicated
 * Redis token-bucket pattern.
 */
interface KvLike {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface KvRateLimitOptions {
	kv: KvLike;
	/** Window size (seconds). Default 60. */
	windowSec?: number;
	/** Max requests per window. */
	maxPerWindow: number;
	/** Key prefix for namespacing. Default 'floe:ratelimit'. */
	prefix?: string;
	/** Custom keying. */
	keyBy?: (ctx: RateLimiterContext) => string;
	name?: string;
}

export class KvRateLimit implements RateLimiter {
	readonly name: string;
	private readonly kv: KvLike;
	private readonly windowSec: number;
	private readonly maxPerWindow: number;
	private readonly prefix: string;
	private readonly keyBy: (ctx: RateLimiterContext) => string;

	constructor(opts: KvRateLimitOptions) {
		if (!opts.kv) throw new Error('[KvRateLimit] kv is required');
		if (opts.maxPerWindow <= 0) throw new Error('[KvRateLimit] maxPerWindow must be > 0');
		this.kv = opts.kv;
		this.windowSec = opts.windowSec ?? 60;
		this.maxPerWindow = opts.maxPerWindow;
		this.prefix = opts.prefix ?? 'floe:ratelimit';
		this.keyBy = opts.keyBy ?? defaultKey;
		this.name = opts.name ?? 'kv-rate-limit';
	}

	async check(ctx: RateLimiterContext): Promise<RateLimitDecision> {
		const epoch = Math.floor(Date.now() / 1000);
		const window = Math.floor(epoch / this.windowSec);
		const key = `${this.prefix}:${this.keyBy(ctx)}:${window}`;
		const existing = await this.kv.get(key);
		const current = existing ? parseInt(existing, 10) || 0 : 0;
		if (current >= this.maxPerWindow) {
			const retryAfterSeconds = this.windowSec - (epoch % this.windowSec);
			return {
				allow: false,
				reason: `Rate limit exceeded for ${this.keyBy(ctx)} (${current}/${this.maxPerWindow} in ${this.windowSec}s)`,
				retryAfterSeconds,
				metadata: { key, current },
			};
		}
		await this.kv.put(key, String(current + 1), { expirationTtl: this.windowSec * 2 });
		return {
			allow: true,
			metadata: { key, current: current + 1, remaining: this.maxPerWindow - current - 1 },
		};
	}
}

export function kvRateLimit(opts: KvRateLimitOptions): KvRateLimit {
	return new KvRateLimit(opts);
}
