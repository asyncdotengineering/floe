/**
 * Unit tests for the streaming mux. The mux translates Flue's native SSE
 * event stream into the canonical OpenAI Chat Completions wire format —
 * the single point both `webAdapter` and `openaiCompat` route through.
 */
import { describe, expect, it } from 'vitest';
import {
	streamAsOpenAISSE,
	bufferAsOpenAIJson,
	encodeFlueEvent,
	roleChunk,
	stopChunk,
	type OpenAIChunkContext,
} from '../src/streaming/index.ts';
import type {
	OpenAIChatCompletion,
	OpenAIChatCompletionChunk,
} from '../src/openai-compat/types.ts';

const CTX: OpenAIChunkContext = {
	id: 'chatcmpl-test',
	created: 1700000000,
	model: 'floe/support',
};

/**
 * Build a fake upstream Flue SSE Response from a list of event objects.
 * Mirrors the wire format the inner Flue dispatcher produces.
 */
function fluUpstream(events: Record<string, unknown>[]): Response {
	const enc = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const evt of events) {
				controller.enqueue(enc.encode(`event: ${evt['type']}\nid: 0\ndata: ${JSON.stringify(evt)}\n\n`));
			}
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	});
}

/** Parse an OpenAI SSE Response body into the chunk objects it emitted. */
async function readOpenAIChunks(res: Response): Promise<{
	chunks: OpenAIChatCompletionChunk[];
	rawLines: string[];
}> {
	const text = await res.text();
	const rawLines = text.split('\n');
	const chunks: OpenAIChatCompletionChunk[] = [];
	for (const block of text.split('\n\n')) {
		const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
		if (!dataLine) continue;
		const payload = dataLine.slice('data: '.length);
		if (payload === '[DONE]') continue;
		try {
			chunks.push(JSON.parse(payload) as OpenAIChatCompletionChunk);
		} catch {
			// non-chunk data line — skip
		}
	}
	return { chunks, rawLines };
}

describe('encodeFlueEvent — pure translation', () => {
	it('text_delta → content delta', () => {
		const out = encodeFlueEvent({ type: 'text_delta', text: 'Hello' }, CTX);
		expect(out?.choices[0]?.delta.content).toBe('Hello');
		expect(out?.choices[0]?.finish_reason).toBe(null);
		expect(out?.object).toBe('chat.completion.chunk');
		expect(out?.id).toBe('chatcmpl-test');
		expect(out?.model).toBe('floe/support');
	});

	it('empty text_delta → null (dropped)', () => {
		expect(encodeFlueEvent({ type: 'text_delta', text: '' }, CTX)).toBe(null);
	});

	it('tool_call → tool_calls delta with assembled function args', () => {
		const out = encodeFlueEvent(
			{
				type: 'tool_call',
				callId: 'call_xyz',
				name: 'processReturn',
				args: { orderId: 'ord_1' },
			},
			CTX,
		);
		const tc = out?.choices[0]?.delta.tool_calls?.[0];
		expect(tc?.id).toBe('call_xyz');
		expect(tc?.function?.name).toBe('processReturn');
		expect(JSON.parse(tc?.function?.arguments ?? '{}')).toEqual({ orderId: 'ord_1' });
	});

	it('drops non-wire events: thinking, conversation_event, run_start, run_end, operation_start, agent_send_text', () => {
		const dropped = [
			{ type: 'run_start', runId: 'r' },
			{ type: 'run_end', result: { text: 'x' } },
			{ type: 'operation_start' },
			{ type: 'thinking_start' },
			{ type: 'thinking_delta', delta: 'reasoning' },
			{ type: 'thinking_end' },
			{ type: 'conversation_event', subtype: 'knowledge_hit' },
			{ type: 'agent_send_text', text: 'this is the final reply' },
			{ type: 'text', text: 'op-level final' },
			{ type: 'tool_start' },
			{ type: 'idle' },
		];
		for (const evt of dropped) {
			expect(encodeFlueEvent(evt, CTX), `should drop ${evt.type}`).toBe(null);
		}
	});

	it('roleChunk + stopChunk shape', () => {
		const role = roleChunk(CTX);
		expect(role.choices[0]?.delta.role).toBe('assistant');
		expect(role.choices[0]?.finish_reason).toBe(null);
		const stop = stopChunk(CTX, 'stop');
		expect(stop.choices[0]?.delta).toEqual({});
		expect(stop.choices[0]?.finish_reason).toBe('stop');
		const stopTools = stopChunk(CTX, 'tool_calls');
		expect(stopTools.choices[0]?.finish_reason).toBe('tool_calls');
	});
});

describe('streamAsOpenAISSE — end-to-end wire', () => {
	it('emits role → content deltas → stop → [DONE]', async () => {
		const upstream = fluUpstream([
			{ type: 'run_start', runId: 'r1' },
			{ type: 'text_delta', text: 'Hello ' },
			{ type: 'text_delta', text: 'world.' },
			{ type: 'agent_send_text', text: 'Hello world.' },
			{ type: 'run_end', result: { text: 'Hello world.', events: [], state: null } },
		]);
		const res = streamAsOpenAISSE(upstream, { ctx: CTX });
		expect(res.headers.get('content-type')).toBe('text/event-stream');
		const { chunks, rawLines } = await readOpenAIChunks(res);
		// role marker
		expect(chunks[0]?.choices[0]?.delta.role).toBe('assistant');
		// two content deltas
		expect(chunks[1]?.choices[0]?.delta.content).toBe('Hello ');
		expect(chunks[2]?.choices[0]?.delta.content).toBe('world.');
		// stop chunk
		expect(chunks[3]?.choices[0]?.finish_reason).toBe('stop');
		expect(chunks[3]?.choices[0]?.delta).toEqual({});
		// terminator
		expect(rawLines.some((l) => l === 'data: [DONE]')).toBe(true);
	});

	it('finish_reason becomes "tool_calls" when the model emitted tools', async () => {
		const upstream = fluUpstream([
			{ type: 'text_delta', text: 'Calling...' },
			{
				type: 'tool_call',
				callId: 'call_1',
				name: 'lookup',
				args: { id: 1 },
			},
			{ type: 'run_end', result: { text: '', events: [], state: null } },
		]);
		const res = streamAsOpenAISSE(upstream, { ctx: CTX });
		const { chunks } = await readOpenAIChunks(res);
		const last = chunks[chunks.length - 1];
		expect(last?.choices[0]?.finish_reason).toBe('tool_calls');
	});

	it('opt-in floe.run debug event appears before [DONE]', async () => {
		const upstream = fluUpstream([
			{ type: 'text_delta', text: 'hi' },
			{ type: 'run_end', result: { text: 'hi', events: [{ type: 'agent_send_text', text: 'hi' }], state: { foo: 1 } } },
		]);
		const res = streamAsOpenAISSE(upstream, { ctx: CTX, includeDebugRunEvent: true });
		const body = await res.text();
		const beforeDone = body.split('data: [DONE]')[0]!;
		expect(beforeDone).toMatch(/event: floe\.run/);
		expect(beforeDone).toMatch(/"foo":1/);
		// And the canonical wire is unaffected: content delta + stop are still there.
		expect(beforeDone).toMatch(/"content":"hi"/);
		expect(beforeDone).toMatch(/"finish_reason":"stop"/);
	});

	it('debug event is NOT emitted by default', async () => {
		const upstream = fluUpstream([
			{ type: 'text_delta', text: 'hi' },
			{ type: 'run_end', result: { text: 'hi', events: [], state: null } },
		]);
		const res = streamAsOpenAISSE(upstream, { ctx: CTX });
		const body = await res.text();
		expect(body).not.toMatch(/floe\.run/);
	});

	it('returns 502 when upstream has no body', () => {
		const upstream = new Response(null, { status: 200 });
		const res = streamAsOpenAISSE(upstream, { ctx: CTX });
		expect(res.status).toBe(502);
	});
});

describe('bufferAsOpenAIJson — opt-out fallback', () => {
	it('collapses content deltas into one chat.completion object', async () => {
		const upstream = fluUpstream([
			{ type: 'text_delta', text: 'Part one. ' },
			{ type: 'text_delta', text: 'Part two.' },
			{ type: 'run_end', result: { text: 'Part one. Part two.', events: [], state: null } },
		]);
		const res = await bufferAsOpenAIJson(upstream, CTX);
		expect(res.headers.get('content-type')).toBe('application/json');
		const body = (await res.json()) as OpenAIChatCompletion;
		expect(body.object).toBe('chat.completion');
		expect(body.choices[0]?.message.content).toBe('Part one. Part two.');
		expect(body.choices[0]?.finish_reason).toBe('stop');
	});

	it('aggregates tool calls into the message + sets finish_reason', async () => {
		const upstream = fluUpstream([
			{ type: 'text_delta', text: 'Looking up… ' },
			{ type: 'tool_call', callId: 'call_a', name: 'lookup', args: { id: 7 } },
			{ type: 'run_end', result: { text: '', events: [], state: null } },
		]);
		const res = await bufferAsOpenAIJson(upstream, CTX);
		const body = (await res.json()) as OpenAIChatCompletion;
		expect(body.choices[0]?.finish_reason).toBe('tool_calls');
		expect(body.choices[0]?.message.tool_calls?.[0]?.function.name).toBe('lookup');
	});
});

describe('streamAsOpenAISSE — bufferHostText (flow-entry leak suppression)', () => {
	function joinContent(chunks: OpenAIChatCompletionChunk[]): string {
		return chunks
			.map((c) => c.choices[0]?.delta?.content ?? '')
			.join('');
	}

	it('bufferHostText=false (default): text streams per-token unchanged', async () => {
		const upstream = fluUpstream([
			{ type: 'operation_start' },
			{ type: 'text_delta', text: 'Hello ' },
			{ type: 'text_delta', text: 'world.' },
			{ type: 'operation' },
			{ type: 'run_end', result: { text: 'Hello world.', events: [], state: null } },
		]);
		const res = streamAsOpenAISSE(upstream, { ctx: CTX });
		const { chunks } = await readOpenAIChunks(res);
		// Two separate per-token deltas (preserved streaming UX).
		const contentChunks = chunks.filter((c) => c.choices[0]?.delta?.content);
		expect(contentChunks).toHaveLength(2);
		expect(joinContent(chunks)).toBe('Hello world.');
	});

	it("bufferHostText=true: text_delta + flow-entry tool in same operation → host text DROPPED", async () => {
		const upstream = fluUpstream([
			{ type: 'operation_start' },
			{ type: 'text_delta', text: "I'll check the timing of that drop for you. " },
			{ type: 'text_delta', text: 'Just a moment.' },
			{
				type: 'tool_call',
				callId: 'call_x',
				name: 'enter_add_drop',
				args: { args: { courseCode: 'CS 351', action: 'drop' } },
			},
			{ type: 'operation' },
			{ type: 'operation_start' },
			{ type: 'text_delta', text: 'Drop of CS 351 confirmed — proceed.' },
			{ type: 'operation' },
			{
				type: 'run_end',
				result: { text: 'Drop of CS 351 confirmed — proceed.', events: [], state: null },
			},
		]);
		const res = streamAsOpenAISSE(upstream, { ctx: CTX, bufferHostText: true });
		const { chunks } = await readOpenAIChunks(res);
		const final = joinContent(chunks);
		expect(final).not.toContain("I'll check the timing");
		expect(final).not.toContain('Just a moment');
		expect(final).toContain('Drop of CS 351 confirmed — proceed.');
	});

	it("bufferHostText=true: text_delta + non-flow tool → text FLUSHED before tool", async () => {
		const upstream = fluUpstream([
			{ type: 'operation_start' },
			{ type: 'text_delta', text: 'Let me look that up. ' },
			{ type: 'tool_call', callId: 'call_y', name: 'lookup_account', args: { id: 1 } },
			{ type: 'operation' },
			{ type: 'run_end', result: { text: '', events: [], state: null } },
		]);
		const res = streamAsOpenAISSE(upstream, { ctx: CTX, bufferHostText: true });
		const { chunks } = await readOpenAIChunks(res);
		expect(joinContent(chunks)).toContain('Let me look that up.');
	});

	it("bufferHostText=true: text only (no tool) → text reaches wire on operation end", async () => {
		const upstream = fluUpstream([
			{ type: 'operation_start' },
			{ type: 'text_delta', text: 'Plain reply.' },
			{ type: 'operation' },
			{ type: 'run_end', result: { text: 'Plain reply.', events: [], state: null } },
		]);
		const res = streamAsOpenAISSE(upstream, { ctx: CTX, bufferHostText: true });
		const { chunks } = await readOpenAIChunks(res);
		expect(joinContent(chunks)).toBe('Plain reply.');
	});

	it("bufferAsOpenAIJson with bufferHostText=true: flow-entry text dropped from message.content", async () => {
		const upstream = fluUpstream([
			{ type: 'operation_start' },
			{ type: 'text_delta', text: "I'll check that. " },
			{
				type: 'tool_call',
				callId: 'call_z',
				name: 'enter_add_drop',
				args: { args: { courseCode: 'CS 351', action: 'drop' } },
			},
			{ type: 'operation' },
			{ type: 'operation_start' },
			{ type: 'text_delta', text: 'Drop of CS 351 confirmed.' },
			{ type: 'operation' },
			{
				type: 'run_end',
				result: { text: 'Drop of CS 351 confirmed.', events: [], state: null },
			},
		]);
		const res = await bufferAsOpenAIJson(upstream, CTX, 'off', true);
		const body = (await res.json()) as OpenAIChatCompletion;
		const content = body.choices[0]?.message.content ?? '';
		expect(content).not.toContain("I'll check that");
		expect(content).toContain('Drop of CS 351 confirmed');
	});
});
