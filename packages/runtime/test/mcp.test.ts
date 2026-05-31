/**
 * MCP registry tests — focus on caching, deduplication, and failure
 * isolation. We mock @flue/runtime's `connectMcpServer` so tests don't
 * need a real MCP server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { connectMock } = vi.hoisted(() => ({ connectMock: vi.fn() }));

vi.mock('@flue/runtime', async () => {
	const actual = await vi.importActual<typeof import('@flue/runtime')>('@flue/runtime');
	return {
		...actual,
		connectMcpServer: connectMock,
	};
});

import { __resetMcpRegistryForTests, getMcpStatus, getMcpTools } from '../src/mcp/registry.ts';
import { prepareTurn } from '../src/orchestrator/prepare-turn.ts';
import type { AssistantConfig, FloeConfig } from '../src/types.ts';

function mockConnection(name: string, toolCount = 2) {
	return {
		name,
		tools: Array.from({ length: toolCount }, (_, i) => ({
			name: `mcp__${name}__tool${i}`,
			description: `tool ${i} from ${name}`,
			parameters: { type: 'object' as const, properties: {} },
			async execute() {
				return 'ok';
			},
		})),
		close: vi.fn().mockResolvedValue(undefined),
	};
}

describe('MCP registry', () => {
	beforeEach(() => {
		connectMock.mockReset();
	});

	afterEach(async () => {
		await __resetMcpRegistryForTests();
	});

	it('returns [] for no configs', async () => {
		expect(await getMcpTools(undefined)).toEqual([]);
		expect(await getMcpTools([])).toEqual([]);
		expect(connectMock).not.toHaveBeenCalled();
	});

	it('connects each server once and reuses the cached connection', async () => {
		connectMock.mockResolvedValue(mockConnection('github', 3));
		const configs = [{ name: 'github', url: 'https://example.test/mcp' }];

		const a = await getMcpTools(configs);
		const b = await getMcpTools(configs);
		const c = await getMcpTools(configs);

		expect(connectMock).toHaveBeenCalledTimes(1);
		expect(a).toHaveLength(3);
		expect(b).toEqual(a);
		expect(c).toEqual(a);
	});

	it('skips a failed server but returns tools from successful ones', async () => {
		connectMock.mockImplementation(async (name: string) => {
			if (name === 'broken') throw new Error('connection refused');
			return mockConnection(name, 2);
		});

		const tools = await getMcpTools([
			{ name: 'github', url: 'https://gh.test/mcp' },
			{ name: 'broken', url: 'https://broken.test/mcp' },
			{ name: 'linear', url: 'https://linear.test/mcp' },
		]);

		expect(tools).toHaveLength(4);
		const status = getMcpStatus();
		const broken = status.find((s) => s.name === 'broken');
		expect(broken?.connected).toBe(false);
		expect(broken?.lastError).toContain('connection refused');
	});

	it('caches a failed connection until retryAt elapses', async () => {
		connectMock.mockRejectedValue(new Error('boom'));
		const configs = [{ name: 'flaky', url: 'https://x.test/mcp', retryAfterMs: 50 }];

		await getMcpTools(configs);
		await getMcpTools(configs);
		expect(connectMock).toHaveBeenCalledTimes(1);

		await new Promise((r) => setTimeout(r, 75));
		await getMcpTools(configs);
		expect(connectMock).toHaveBeenCalledTimes(2);
	});

	it('rejects duplicate server names within one call', async () => {
		await expect(
			getMcpTools([
				{ name: 'dup', url: 'https://a.test/mcp' },
				{ name: 'dup', url: 'https://b.test/mcp' },
			]),
		).rejects.toThrow(/Duplicate MCP server name "dup"/);
	});

	it('forwards MCP tools through prepare-turn into ctx.init', async () => {
		connectMock.mockResolvedValue(mockConnection('stub', 1));

		const capturedInit: Array<{ tools?: unknown }> = [];
		const captureCtx = {
			id: 'sess-mcp',
			runId: 'run-mcp',
			init: async (opts: { tools?: unknown }) => {
				capturedInit.push(opts);
				return {
					session: async () => ({
						prompt: async () => ({ text: 'ok', usage: undefined }),
						name: 'sess',
					}),
				};
			},
		};
		const convo: AssistantConfig = {
			name: 'test',
			agents: [{ id: 'greeter', description: 'g', systemPrompt: 'You greet.' }],
			triage: 'first-agent',
		};
		const channel = {
			name: 'web',
			kind: 'http' as const,
			async parseInbound() {
				return { type: 'user_text_sent' as const, content: 'hi', eventId: 'e' };
			},
		};
		const defaults: FloeConfig['defaults'] = {
			model: 'test',
			sandbox: false,
			mcp: [{ name: 'stub', url: 'https://stub.test/mcp' }],
		};

		const result = await prepareTurn({
			ctx: captureCtx as never,
			convo,
			channel,
			defaults,
		});
		expect(result.kind).toBe('continue');
		expect(capturedInit).toHaveLength(1);
		const tools = capturedInit[0]!.tools as Array<{ name: string }> | undefined;
		expect(tools).toBeDefined();
		expect(tools!.map((t) => t.name)).toContain('mcp__stub__tool0');
	});

	it('omits init.tools when all MCP servers fail', async () => {
		connectMock.mockRejectedValue(new Error('all down'));
		const capturedInit: Array<{ tools?: unknown }> = [];
		const captureCtx = {
			id: 'sess-mcp-fail',
			runId: 'run-mcp-fail',
			init: async (opts: { tools?: unknown }) => {
				capturedInit.push(opts);
				return {
					session: async () => ({
						prompt: async () => ({ text: 'ok', usage: undefined }),
						name: 'sess',
					}),
				};
			},
		};
		const result = await prepareTurn({
			ctx: captureCtx as never,
			convo: {
				name: 'test',
				agents: [{ id: 'greeter', description: 'g', systemPrompt: 'You greet.' }],
				triage: 'first-agent',
			},
			channel: {
				name: 'web',
				kind: 'http' as const,
				async parseInbound() {
					return { type: 'user_text_sent' as const, content: 'hi', eventId: 'e' };
				},
			},
			defaults: {
				model: 'test',
				sandbox: false,
				mcp: [{ name: 'down', url: 'https://down.test/mcp' }],
			},
		});
		expect(result.kind).toBe('continue');
		expect(capturedInit[0]!.tools).toBeUndefined();
	});

	it('deduplicates concurrent first-time connects (no thundering herd)', async () => {
		let resolveConnect!: (v: ReturnType<typeof mockConnection>) => void;
		connectMock.mockImplementation(
			() =>
				new Promise((res) => {
					resolveConnect = res;
				}),
		);
		const configs = [{ name: 'slow', url: 'https://s.test/mcp' }];

		const a = getMcpTools(configs);
		const b = getMcpTools(configs);
		const c = getMcpTools(configs);

		await new Promise((r) => setTimeout(r, 10));
		resolveConnect(mockConnection('slow', 1));

		const [ra, rb, rc] = await Promise.all([a, b, c]);
		expect(connectMock).toHaveBeenCalledTimes(1);
		expect(ra).toHaveLength(1);
		expect(rb).toEqual(ra);
		expect(rc).toEqual(ra);
	});
});
