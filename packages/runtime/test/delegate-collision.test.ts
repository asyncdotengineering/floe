/**
 * Regression test for the delegate/task collision patch.
 *
 * The wire-level bug — Flue 0.7's auto-injected `task` calling
 * `runExclusive('task')` on a session that's currently running a
 * `prompt` — is patched at the Flue layer (patches/@flue__runtime@0.7.0.patch).
 * The patch makes `runTaskForTool` return a graceful "task not available"
 * tool result when activeOperation is set, instead of letting the
 * underlying `runExclusive` throw "Session is already running prompt".
 *
 * This test forces the LLM (via the faux provider) to call `task` from
 * inside a delegate-spawned child's prompt loop — the exact bug pattern.
 * Without the patch this throws and is surfaced as a tool error; with
 * the patch the call returns the graceful payload and the test
 * completes without any "already running" error in flight.
 *
 * Run:  pnpm --filter @floe/runtime test delegate-collision
 */
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { observe } from '@flue/runtime/app';
import type { FlueEvent } from '@flue/runtime';
import {
	registerFloeFaux,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type FloeFauxHandle,
} from '../src/testing/faux.ts';
import { Assistant } from '../src/assistant.ts';

let faux: FloeFauxHandle | null = null;

afterEach(() => {
	if (faux) {
		faux.unregister();
		faux = null;
	}
});

describe('delegate/task collision — Flue patch verification', () => {
	it('pnpm patch is materialized in @flue/runtime — fast-fail on regression', () => {
		// Belt-and-braces: if a future `pnpm install` ever fails to apply
		// patches/@flue__runtime@0.7.0.patch (version bump, --ignore-patches,
		// hash mismatch on the bundle filename) we want THIS test to fail
		// instead of the bug silently re-emerging in production. The patch
		// is identified by the `[floe-patch]` comment marker in the
		// runTaskForTool function it edits.
		// Resolve via the default export (works under ESM-only `exports`
		// where subpaths like `/app` may not be visible to CJS require).
		const indexUrl = import.meta.resolve('@flue/runtime');
		const distDir = new URL('.', indexUrl).pathname.replace(/\/$/, '');
		const sandboxFile = readdirSync(distDir).find(
			(f) => f.startsWith('sandbox-') && f.endsWith('.mjs'),
		);
		expect(sandboxFile, 'no sandbox-*.mjs file in @flue/runtime/dist').toBeTruthy();
		const contents = readFileSync(`${distDir}/${sandboxFile}`, 'utf8');
		expect(
			contents,
			'patches/@flue__runtime@0.7.0.patch is not applied — run `pnpm install` or regenerate the patch against the current @flue/runtime bundle',
		).toContain('[floe-patch]');
	});

	it('LLM calling task from inside its own prompt does not surface a lock-collision error', async () => {
		// Load-bearing assertion (verified by neutering the patch +
		// re-running — test failure mode confirmed): subscribe to
		// Flue's event stream and confirm no `tool_call` event for the
		// `task` builtin surfaces the "Session is already running
		// prompt" error.
		//
		// Without the patch: runExclusive("task") throws inside
		// runTaskForTool → Flue's tool layer catches the throw and
		// emits {type:"tool_call", toolName:"task", isError:true,
		// result.content[0].text:"[flue] Session ... is already running
		// prompt..."}. With the patch, runTaskForTool short-circuits to
		// the graceful payload before runTask is called, so isError is
		// false and the text does not contain the lock-collision string.
		//
		// Faux script — served FIFO across all sessions:
		//   1. parent: call delegate(role=service)
		//   2. child#1: call task(role=service)  ← would throw without patch
		//   3. child#1: text reply               ← LLM's "answer directly"
		//   4. parent: final wrap-up
		faux = registerFloeFaux({
			provider: 'collision-loop',
			models: [{ id: 'test' }],
			responses: [
				fauxAssistantMessage([
					fauxToolCall('delegate', { role: 'service', prompt: 'look up alice' }),
				]),
				fauxAssistantMessage([
					fauxToolCall('task', { role: 'service', prompt: 'sub-lookup' }),
				]),
				fauxAssistantMessage([fauxText('Alice reports to Bob.')]),
				fauxAssistantMessage([fauxText('Per the service specialist: Alice reports to Bob.')]),
			],
		});

		const taskToolCollisions: Array<{ session?: string; text: string }> = [];
		const unsub = observe((evt: FlueEvent) => {
			if (
				evt.type !== 'tool_call' ||
				(evt as { toolName?: string }).toolName !== 'task' ||
				(evt as { isError?: boolean }).isError !== true
			) {
				return;
			}
			const result = (evt as { result?: { content?: Array<{ text?: string }> } }).result;
			const text = result?.content?.[0]?.text ?? '';
			if (/already running prompt/i.test(text)) {
				taskToolCollisions.push({
					session: (evt as { session?: string }).session,
					text: text.slice(0, 200),
				});
			}
		});

		try {
			const a = new Assistant({
				name: 'collision-bot',
				systemPrompt: 'You coordinate specialists.',
				mode: 'coordinate',
				model: 'collision-loop/test',
				sandbox: false,
				roles: {
					service: {
						name: 'service',
						instructions: 'You are the service specialist.',
					},
				},
			});

			const out = await a.run('look up alice@acme.example', {
				sessionId: `collision-${crypto.randomUUID()}`,
			});

			expect(out.content).toBeTruthy();
			expect(
				taskToolCollisions,
				`Flue emitted lock-collision tool_call(s) for \`task\` — patch is not effective. Collisions: ${JSON.stringify(taskToolCollisions).slice(0, 500)}`,
			).toEqual([]);
		} finally {
			unsub();
		}
	}, 10_000);
});
