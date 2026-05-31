/**
 * AriaFlow flow competitor server.
 *
 * Same 3-step booking flow as @floe/example-flow-bot:
 *   collect_name → collect_slot → confirm (text-producing — turn ends)
 *
 * AriaFlow uses tool-driven transitions: each node has tools, and a tool
 * returning `createFlowTransition('next-node-id', data)` advances the flow.
 * This is a different architecture from Floe (handler-returns-Node) but
 * accomplishes the same goal.
 *
 * Response shape mirrors Floe's web-chat JSON so the bench harness fields
 * line up.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Runtime, createFlowTransition, type FlowAgentConfig, type FlowContext } from '@ariaflowagents/core';
import { openai } from '@ai-sdk/openai';
import { google } from '@ai-sdk/google';
import { tool } from 'ai';
import { z } from 'zod';

const PORT = Number(process.env.PORT ?? 3600);
const MODEL_ID = process.env.BENCH_MODEL ?? 'openai/gpt-4.1-mini';

function resolveModel(id: string) {
	const [provider, ...rest] = id.split('/');
	const name = rest.join('/');
	if (provider === 'openai') return openai(name);
	if (provider === 'google') return google(name);
	throw new Error(`Unsupported provider: ${provider}`);
}

const model = resolveModel(MODEL_ID) as any;

function bookingFlow() {
	return {
		nodes: [
			{
				id: 'collect_name',
				prompt:
					'Extract the customer\'s name from the user\'s message. As SOON as you have a name, call set_name to advance. Do not reply with text — just call the function.',
				tools: (_ctx: FlowContext) => ({
					set_name: tool({
						description: 'Record the customer name and advance to collecting the slot.',
						inputSchema: z.object({ customerName: z.string() }),
						execute: async ({ customerName }) =>
							createFlowTransition('collect_slot', { customerName }),
					}),
				}),
			},
			{
				id: 'collect_slot',
				prompt:
					'Extract the booking slot from the conversation and normalize to "Day at HH:MMam/pm" (e.g. "Friday at 2:00pm"). As SOON as you have a slot, call set_slot to advance. Do not reply with text — just call the function.',
				tools: (_ctx: FlowContext) => ({
					set_slot: tool({
						description: 'Record the booking slot and advance to confirmation.',
						inputSchema: z.object({ slot: z.string() }),
						execute: async ({ slot }) =>
							createFlowTransition('confirm', { slot }),
					}),
				}),
			},
			{
				id: 'confirm',
				prompt:
					'You have customerName and slot in collected data. Reply ONLY with: "I have you down as ${customerName} for ${slot}. Shall I confirm the booking?" Use the actual values. Do NOT call any function.',
				tools: (_ctx: FlowContext) => ({}),
			},
		],
	};
}

const agent: FlowAgentConfig = {
	id: 'booking',
	name: 'Booking Flow',
	type: 'flow',
	prompt: 'You are a personal concierge handling bookings. Be warm and brief.',
	model,
	flow: bookingFlow(),
	initialNode: 'collect_name',
	mode: 'strict',
};

const runtime = new Runtime({
	agents: [agent],
	defaultAgentId: agent.id,
	defaultModel: model,
});

interface RunResult {
	text: string;
	ttftMs: number | null;
	endToEndMs: number;
	deltaCount: number;
	deltaBytes: number;
	streamingObserved: boolean;
}

async function runTurn(input: string, sessionId?: string): Promise<RunResult & { sessionId?: string }> {
	const startedAt = Date.now();
	let firstDeltaAt: number | null = null;
	let deltaCount = 0, deltaBytes = 0, text = '';
	let outSession: string | undefined = sessionId;
	for await (const part of runtime.stream({ input, sessionId })) {
		if (part.type === 'text-delta') {
			deltaCount += 1;
			deltaBytes += part.text.length;
			text += part.text;
			if (firstDeltaAt === null) firstDeltaAt = Date.now();
		} else if (part.type === 'done') {
			outSession = part.sessionId;
		}
	}
	return {
		text,
		ttftMs: firstDeltaAt !== null ? firstDeltaAt - startedAt : null,
		endToEndMs: Date.now() - startedAt,
		deltaCount,
		deltaBytes,
		streamingObserved: deltaCount > 0,
		sessionId: outSession,
	};
}

function send(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const raw = Buffer.concat(chunks).toString('utf8');
	return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

const server = createServer(async (req, res) => {
	try {
		if (req.method === 'GET' && req.url === '/') {
			return send(res, 200, { ok: true, framework: 'ariaflow-flow', model: MODEL_ID });
		}
		if (req.method === 'POST' && req.url?.startsWith('/agents/web/')) {
			const sessionId = req.url.slice('/agents/web/'.length) || undefined;
			const body = await readJson(req);
			const message = String(body.message ?? '');
			const result = await runTurn(message, sessionId);
			return send(res, 200, {
				result: {
					text: result.text,
					events: [],
					stream: {
						ttftMs: result.ttftMs,
						endToEndMs: result.endToEndMs,
						deltaCount: result.deltaCount,
						deltaBytes: result.deltaBytes,
						streamingObserved: result.streamingObserved,
					},
				},
			});
		}
		send(res, 404, { error: 'not_found' });
	} catch (err) {
		console.error('[aria-flow-server] error:', err);
		send(res, 500, { error: err instanceof Error ? err.message : String(err) });
	}
});

server.listen(PORT, () => {
	console.error(`[aria-flow-server] listening on http://localhost:${PORT}  model=${MODEL_ID}`);
});
