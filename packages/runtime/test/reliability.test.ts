import { describe, expect, it } from 'vitest';
import {
	TokenBucketRateLimit,
	KvRateLimit,
	tokenBucketRateLimit,
} from '../src/reliability/rate-limit.ts';
import { isRetriableError, withFailover } from '../src/reliability/provider-failover.ts';
import type { RateLimiterContext } from '../src/reliability/types.ts';

describe('TokenBucketRateLimit', () => {
	const ctx = (userId: string): RateLimiterContext => ({
		conversation: 'support',
		userId,
		input: { type: 'user_text_sent', content: 'hi', eventId: 'e1' },
		channelName: 'web',
	});

	it('allows up to capacity, then rejects', () => {
		const rl = new TokenBucketRateLimit({ capacity: 3, refillPerSec: 0.01 });
		expect(rl.check(ctx('u1')).allow).toBe(true);
		expect(rl.check(ctx('u1')).allow).toBe(true);
		expect(rl.check(ctx('u1')).allow).toBe(true);
		const fourth = rl.check(ctx('u1'));
		expect(fourth.allow).toBe(false);
		expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
	});

	it('isolates buckets by userId', () => {
		const rl = new TokenBucketRateLimit({ capacity: 1, refillPerSec: 0.001 });
		expect(rl.check(ctx('alice')).allow).toBe(true);
		expect(rl.check(ctx('bob')).allow).toBe(true);
		expect(rl.check(ctx('alice')).allow).toBe(false);
	});

	it('refills over time', async () => {
		const rl = new TokenBucketRateLimit({ capacity: 1, refillPerSec: 100 });
		expect(rl.check(ctx('a')).allow).toBe(true);
		expect(rl.check(ctx('a')).allow).toBe(false);
		await new Promise((r) => setTimeout(r, 15));
		expect(rl.check(ctx('a')).allow).toBe(true);
	});

	it('factory helper works', () => {
		const rl = tokenBucketRateLimit({ capacity: 2, refillPerSec: 1 });
		expect(rl.name).toBe('token-bucket');
	});

	it('rejects invalid capacity', () => {
		expect(() => new TokenBucketRateLimit({ capacity: 0, refillPerSec: 1 })).toThrow();
		expect(() => new TokenBucketRateLimit({ capacity: 1, refillPerSec: 0 })).toThrow();
	});
});

describe('KvRateLimit', () => {
	function mockKv(): {
		store: Map<string, string>;
		api: ConstructorParameters<typeof KvRateLimit>[0]['kv'];
	} {
		const store = new Map<string, string>();
		return {
			store,
			api: {
				async get(key: string) {
					return store.get(key) ?? null;
				},
				async put(key: string, value: string) {
					store.set(key, value);
				},
			},
		};
	}

	const baseCtx: RateLimiterContext = {
		conversation: 'support',
		userId: 'alice',
		input: { type: 'user_text_sent', content: 'hi', eventId: 'e1' },
		channelName: 'web',
	};

	it('allows up to maxPerWindow then rejects', async () => {
		const { api } = mockKv();
		const rl = new KvRateLimit({ kv: api, maxPerWindow: 2 });
		expect((await rl.check(baseCtx)).allow).toBe(true);
		expect((await rl.check(baseCtx)).allow).toBe(true);
		const denied = await rl.check(baseCtx);
		expect(denied.allow).toBe(false);
		expect(denied.retryAfterSeconds).toBeGreaterThan(0);
	});

	it('keys by user separately', async () => {
		const { api } = mockKv();
		const rl = new KvRateLimit({ kv: api, maxPerWindow: 1 });
		expect((await rl.check({ ...baseCtx, userId: 'a' })).allow).toBe(true);
		expect((await rl.check({ ...baseCtx, userId: 'b' })).allow).toBe(true);
		expect((await rl.check({ ...baseCtx, userId: 'a' })).allow).toBe(false);
	});
});

describe('isRetriableError', () => {
	it('treats 429 + 5xx as retriable', () => {
		expect(isRetriableError({ status: 429 })).toBe(true);
		expect(isRetriableError({ status: 500 })).toBe(true);
		expect(isRetriableError({ httpStatus: 503 })).toBe(true);
	});
	it('treats 4xx (non-429) as non-retriable', () => {
		expect(isRetriableError({ status: 400, message: 'bad request' })).toBe(false);
		expect(isRetriableError({ status: 404 })).toBe(false);
	});
	it('detects network errors by message', () => {
		expect(isRetriableError(new Error('ECONNRESET'))).toBe(true);
		expect(isRetriableError(new Error('fetch failed'))).toBe(true);
		expect(isRetriableError(new Error('rate limit exceeded'))).toBe(true);
	});
	it('returns false for unknown errors', () => {
		expect(isRetriableError(null)).toBe(false);
		expect(isRetriableError(new Error('your prompt is invalid'))).toBe(false);
	});
});

describe('withFailover', () => {
	it('returns first success', async () => {
		const result = await withFailover(
			{ models: ['a', 'b', 'c'] },
			async (model) => `ok-${model}`,
		);
		expect(result.value).toBe('ok-a');
		expect(result.model).toBe('a');
		expect(result.attempts).toHaveLength(1);
	});

	it('falls through retriable errors', async () => {
		const result = await withFailover({ models: ['a', 'b'] }, async (model) => {
			if (model === 'a') throw Object.assign(new Error('rate limited'), { status: 429 });
			return `ok-${model}`;
		});
		expect(result.value).toBe('ok-b');
		expect(result.model).toBe('b');
		expect(result.attempts).toHaveLength(2);
		expect(result.attempts[0]!.error).toBeDefined();
		expect(result.attempts[1]!.result).toBe('ok-b');
	});

	it('rethrows non-retriable errors immediately', async () => {
		await expect(
			withFailover({ models: ['a', 'b'] }, async () => {
				throw Object.assign(new Error('bad request'), { status: 400 });
			}),
		).rejects.toThrow(/bad request/);
	});

	it('throws when all retriable attempts exhaust', async () => {
		await expect(
			withFailover({ models: ['a', 'b'] }, async () => {
				throw Object.assign(new Error('overloaded'), { status: 503 });
			}),
		).rejects.toThrow(/overloaded/);
	});

	it('throws when policy is empty', async () => {
		await expect(withFailover({ models: [] }, async () => 'x')).rejects.toThrow(/empty/);
	});
});
