# role-spike — what the live run actually proved

Live run captured in `conversation.md`. Model: `openai/gpt-4.1-mini`.
Both turns completed end-to-end. Below: what we proved, what we found,
what it means for ADR-0002.

## ✅ Proved (these are real, captured in the trace)

1. **`conversation.roles` reaches Flue's `agentConfig.roles`.** Added in
   `packages/runtime/src/create-floe-app.ts`; verified by the fact that
   the LLM saw the roles in its system prompt (it cites them by name in
   its tool-call arguments below).

2. **Flue's auto-injected `task` tool is visible to the host LLM**, and
   the LLM uses it. The trace shows multiple `tool_start` events of
   shape `task id=call_XXX args={"role":"billing","prompt":"..."}`.

3. **The LLM picks roles semantically based on the question.** For the
   billing question (turn 1) it called `task({role: 'billing', ...})`.
   For the engineering question (turn 2) it called `task({role:
   'engineering', ...})`. **Zero Floe-level triage call** — the routing
   was the host LLM's tool choice based on the role registry Flue
   injected into the system prompt.

4. **The streaming + observability stack works against the new path.**
   Real `text_delta` events fired; `task_start` / `tool_start` /
   `tool_call` events all captured via `observe()`.

## ❌ Found (a real integration bug to fix before ADR-0002 ships)

Every `task` invocation returned the SAME error from Flue:

```
[flue] Session "default" is already running prompt.
Start another session for parallel conversation branches.
```

What's happening: Floe's orchestrator (`prepare-turn.ts`) creates ONE
session via `harness.session()` (no name → default). The host LLM's
`prompt()` is in flight on that session. When the LLM emits a `task`
tool call, Flue's task tool tries to spawn a child run — but Flue's
session-lock check sees "default" is busy and rejects.

Flue's own README says tasks "share the same sandbox/filesystem, but
get their own message history" — so they should NOT contend on the
parent session's lock. The integration point that's wrong is on Floe's
side: we need to either (a) name our session something other than
"default" so the task tool's child has room, (b) pass an explicit
session option to `init` that gives task its own scope, or (c) read
Flue's task internals to understand which call site actually wants
isolation.

This is a separate fix that needs investigation in Flue's source —
specifically `repo/flue/packages/runtime/src/session.ts:1030` where
`task` emits `operation_start`, and the surrounding session-lock
mechanism around lines 924-1085.

The bot still produced text replies (the host's own LLM call finished
fine), but the replies were hedged ("a billing specialist will confirm
shortly...") because the host had nothing back from the task calls
to synthesize from.

## What this means for ADR-0002

**The deletion of `defineAgent` is unblocked by routing semantics
(proven) but blocked by this session-lock issue.** Three sequencing
options:

1. **Fix the session-lock issue first, then delete `defineAgent`.**
   Cleanest. The migration of `support-bot` (the multi-agent example)
   depends on `task` actually running, so this has to work first.

2. **Delete `defineAgent` now, accept that `support-bot`'s live test
   will fail until the session-lock fix lands.** Faster surface
   cleanup, but breaks the green-tests discipline.

3. **Stage `defineAgent` deletion behind a feature flag.** Over-
   engineered for pre-v1.

**Recommendation: option 1.** Investigate the session-lock interaction
between Flue's task and Floe's orchestrator before doing the
destruction work. Likely small fix (one-line change to how we create
the session, or pass an option to init) — but needs to be confirmed.

## How to investigate the session-lock issue

- Read `repo/flue/packages/runtime/src/session.ts:920-1090` (the
  `createCustomTools` path and the `task` handler)
- Read `repo/flue/packages/runtime/src/agent.ts:295-321` (createTaskTool
  and runTask)
- Check whether `runTask` is meant to call `harness.session(<new-name>)`
  internally — and whether Floe's `await harness.session()` (no name)
  collides with that
- Try in the spike: change `await harness.session()` to
  `await harness.session('host-turn')` and see if task calls succeed

If a one-line fix works, lift it into `prepare-turn.ts` and re-run the
spike. The `tool_end` events should then show real role responses
instead of the session-busy error.

## How to reproduce

```bash
# from examples/role-spike/
set -a && source ../../.env && set +a   # note: ../../.env, NOT .env.local
                                         # (.env.local has quote+\n issue,
                                         # produces invalid API keys when sourced)
pnpm spike
```

The driver overwrites `conversation.md` with the live transcript.
Inspect `tool_end` events for the session-busy error.
