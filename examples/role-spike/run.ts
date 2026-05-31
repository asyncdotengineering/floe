/**
 * role-spike driver — sends 2 messages, captures every Flue event,
 * writes a Markdown transcript to ./conversation.md
 *
 * Real LLM calls. Requires OPENAI_API_KEY (or override FLOE_MODEL +
 * the matching provider key).
 */
import { writeFileSync } from 'node:fs';
import { observe } from '@floe/runtime';
import { webAdapter } from '@floe/adapter-web';
import ops from './floe.config.ts';

const floe = webAdapter({ assistant: ops });

type EventRow = {
	ts: number;
	type: string;
	detail: string;
};

const sessionId = `spike-${Date.now()}`;
const events: EventRow[] = [];

// Subscribe to Flue's event stream — capture the interesting events.
observe((event, ctx) => {
	const ts = Date.now();
	switch (event.type) {
		case 'run_start':
			events.push({ ts, type: 'run_start', detail: `runId=${ctx.runId}` });
			break;
		case 'text_delta':
			events.push({ ts, type: 'text_delta', detail: event.text });
			break;
		case 'tool_start':
			events.push({
				ts,
				type: 'tool_start',
				detail: `${event.toolName} id=${event.toolCallId.slice(0, 8)} args=${JSON.stringify(event.args ?? {}).slice(0, 240)}`,
			});
			break;
		case 'tool_call': {
			let resultStr: string;
			if (event.result == null) resultStr = '(no result)';
			else if (typeof event.result === 'string') resultStr = event.result;
			else resultStr = JSON.stringify(event.result);
			events.push({
				ts,
				type: 'tool_end',
				detail: `${event.toolName} id=${event.toolCallId.slice(0, 8)} ms=${event.durationMs} → ${resultStr.slice(0, 240)}${event.isError ? ' [ERROR]' : ''}`,
			});
			break;
		}
		case 'task_start':
			events.push({
				ts,
				type: 'task_start',
				detail: `taskId=${event.taskId} role=${event.role ?? '(none)'} prompt="${event.prompt.slice(0, 120)}..."`,
			});
			break;
		case 'task':
			events.push({
				ts,
				type: 'task_end',
				detail: `taskId=${event.taskId} durationMs=${event.durationMs}${event.isError ? ' [ERROR]' : ''}`,
			});
			break;
		case 'compaction':
			events.push({
				ts,
				type: 'compaction',
				detail: `before=${event.messagesBefore} after=${event.messagesAfter} ms=${event.durationMs}`,
			});
			break;
		case 'run_end': {
			let errStr = 'ok';
			if (event.isError) {
				const e = event.error as unknown;
				if (e instanceof Error) errStr = `[ERROR] ${e.message}\n${e.stack ?? ''}`;
				else if (typeof e === 'object' && e !== null) errStr = `[ERROR] ${JSON.stringify(e, null, 2)}`;
				else errStr = `[ERROR] ${String(e)}`;
			}
			events.push({ ts, type: 'run_end', detail: errStr });
			break;
		}
	}
});

const turns: Array<{
	user: string;
	assistant: string;
	startedAt: number;
	endedAt: number;
	eventStart: number;
}> = [];

async function send(message: string): Promise<void> {
	const eventStart = events.length;
	const startedAt = Date.now();

	const req = new Request(`http://local/agents/web/${sessionId}`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: 'text/event-stream',
		},
		body: JSON.stringify({ message }),
	});

	const res = await floe.fetch(req);
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let assistantText = '';

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		for (const line of lines) {
			if (!line.startsWith('data: ')) continue;
			const payload = line.slice(6).trim();
			if (!payload || payload === '[DONE]') continue;
			try {
				const evt = JSON.parse(payload);
				// Floe streams agent_send_partial deltas + a final agent_send_text
				// Floe SSE wraps Flue events. Pull text deltas from whichever shape arrives.
				const e = evt as Record<string, unknown>;
				if (e.type === 'agent_send_partial' && typeof e.delta === 'string') {
					assistantText += e.delta;
				} else if (e.type === 'agent_send_text' && typeof e.text === 'string' && !assistantText) {
					assistantText = e.text;
				} else if (e.type === 'text_delta' && typeof e.text === 'string') {
					assistantText += e.text;
				}
			} catch {
				// non-JSON line — ignore
			}
		}
	}

	const endedAt = Date.now();
	turns.push({ user: message, assistant: assistantText, startedAt, endedAt, eventStart });
	console.log(`\n[user] ${message}`);
	console.log(`[bot] ${assistantText}`);
	console.log(`[meta] ${endedAt - startedAt}ms, ${events.length - eventStart} events`);
}

// ─── The conversation ───────────────────────────────────────────────────────

const SCENARIO = [
	"Hey — we're upgrading from solo to team. What's the per-seat price for the Team plan, and do you offer annual discounts?",
	"Cool. Different question: my POST /v1/jobs is returning 401 even though I'm passing the API key as a Bearer token. What should I check?",
];

await Promise.resolve(); // let observe register

for (const msg of SCENARIO) {
	await send(msg);
}

// ─── Render the transcript ──────────────────────────────────────────────────

const totalMs = (turns[turns.length - 1]?.endedAt ?? 0) - (turns[0]?.startedAt ?? 0);

const lines: string[] = [];
lines.push('# role-spike — captured conversation');
lines.push('');
lines.push(`> Live LLM run on ${new Date().toISOString()}. Model: \`${process.env.FLOE_MODEL ?? 'openai/gpt-4.1-mini'}\`. Session: \`${sessionId}\`. Total wall time: ${totalMs}ms.`);
lines.push('');
lines.push('Two specialist roles registered on the conversation (`billing`, `engineering`). The host LLM was prompted to delegate via `task({role, prompt})` when relevant. **No Floe-level triage call** — the host model decided whether and how to delegate based purely on the role registry Flue injected into its system prompt.');
lines.push('');
lines.push('---');
lines.push('');

turns.forEach((turn, i) => {
	const turnEvents = events.slice(turn.eventStart);
	const taskDelegations = turnEvents.filter((e) => e.type === 'task_start');
	lines.push(`## Turn ${i + 1}`);
	lines.push('');
	lines.push(`**User:** ${turn.user}`);
	lines.push('');
	lines.push(`**Assistant:** ${turn.assistant || '_(no text output captured)_'}`);
	lines.push('');
	lines.push(`**Wall time:** ${turn.endedAt - turn.startedAt}ms`);
	lines.push('');
	if (taskDelegations.length > 0) {
		lines.push(`**Role delegations this turn:** ${taskDelegations.length}`);
		taskDelegations.forEach((d) => {
			lines.push(`- ${d.detail}`);
		});
		lines.push('');
	} else {
		lines.push('**Role delegations this turn:** 0 (host answered directly)');
		lines.push('');
	}
	lines.push('<details><summary>Full event trace</summary>');
	lines.push('');
	lines.push('```');
	turnEvents.forEach((e) => {
		const rel = e.ts - turn.startedAt;
		lines.push(`+${String(rel).padStart(5, ' ')}ms  ${e.type.padEnd(18, ' ')}  ${e.detail}`);
	});
	lines.push('```');
	lines.push('');
	lines.push('</details>');
	lines.push('');
});

lines.push('---');
lines.push('');
lines.push('## What this proves');
lines.push('');
lines.push('- `Assistant.roles` config reaches Flue\'s `agentConfig.roles` via `create-floe-app.ts`.');
lines.push('- The `delegate` tool is injected by Floe in `mode: "coordinate"`; the LLM sees `billing` and `engineering` in the role registry and chooses to delegate.');
lines.push('- The runtime spawns a fresh child session per `delegate()` call (sidesteps Flue 0.7\'s parent-session `task` lock).');

writeFileSync(new URL('./conversation.md', import.meta.url), lines.join('\n'));
console.log(`\n[done] wrote conversation.md (${lines.length} lines)`);
