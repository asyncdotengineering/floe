# role-spike — conversation (SIMULATED)

> **NOTE — this is a hand-crafted illustration**, not a captured live
> run. The real run attempt is preserved in `conversation.md` and
> shows the spike code working end-to-end up to the LLM provider
> (where it received a 401 — both API keys in `.env.local` are
> rotated/invalid). Plug a working key and run `pnpm spike` to
> generate a real transcript.

The shape below reflects what the spike WOULD capture when the keys
are valid. Timings, token counts, and exact wording are illustrative.
The event types, role-delegation pattern, and orchestrator flow are
all real (they're what `observe()` actually emits).

Model: `openai/gpt-4.1-mini`. Session: `spike-XXXXXXXXXXX`.
Two specialist roles registered (`billing`, `engineering`). No
Floe-level triage call — the host model decides whether and how to
delegate via Flue's auto-injected `task` tool.

---

## Turn 1

**User:** Hey — we're upgrading from solo to team. What's the per-seat price for the Team plan, and do you offer annual discounts?

**Assistant:** Team plan is $24 per seat per month, or $20 per seat with annual billing — about 16% off.

**Wall time:** ~2400ms

**Role delegations this turn:** 1

- `taskId=tsk_a1b2 role=billing prompt="What is the per-seat price for the Team plan, and are there annual discounts?..."`

<details><summary>Full event trace (illustrative)</summary>

```
+   12ms  run_start           runId=run_01JZRA...
+   18ms  tool_call_start     task({"prompt":"What is the per-seat price for the Team plan, an...
+   22ms  task_start          taskId=tsk_a1b2 role=billing prompt="What is the per-seat price for the Team plan..."
+ 1180ms  task_end            taskId=tsk_a1b2 durationMs=1158
+ 1184ms  tool_call_end       task → "Team plan is $24/seat/month. Annual billing brings it to $20/seat/month..."
+ 1196ms  text_delta          Team plan
+ 1224ms  text_delta           is $24 per seat per month, or $20 per seat with annual
+ 1248ms  text_delta           billing — about 16% off.
+ 2387ms  run_end             ok
```

</details>

## Turn 2

**User:** Cool. Different question: my POST /v1/jobs is returning 401 even though I'm passing the API key as a Bearer token. What should I check?

**Assistant:** A 401 with a Bearer token usually means one of three things — verify the header is `Authorization: Bearer <key>` (not `Token` or `Basic`), confirm the key is from the right environment (live keys 401 against the sandbox endpoint and vice-versa), and check whether the key has the `jobs:write` scope. If all three look right, request a fresh key and retry.

**Wall time:** ~2100ms

**Role delegations this turn:** 1

- `taskId=tsk_c3d4 role=engineering prompt="Customer's POST /v1/jobs returns 401 despite Bearer auth header..."`

<details><summary>Full event trace (illustrative)</summary>

```
+   10ms  run_start           runId=run_01JZRB...
+   16ms  tool_call_start     task({"prompt":"Customer's POST /v1/jobs returns 401 despite Bearer...
+   19ms  task_start          taskId=tsk_c3d4 role=engineering prompt="Customer's POST /v1/jobs returns 401..."
+ 1102ms  task_end            taskId=tsk_c3d4 durationMs=1083
+ 1106ms  tool_call_end       task → "Common 401 causes with Bearer auth: (1) wrong header keyword..."
+ 1118ms  text_delta          A 401 with a Bearer token
+ 1148ms  text_delta            usually means one of three things — verify the
+ 1176ms  text_delta           header is `Authorization: Bearer <key>` (not...
+ 2089ms  run_end             ok
```

</details>

---

## What this would prove (when run live)

- `conversation.roles` config reaches Flue's `agentConfig.roles` via the wiring added in `create-floe-app.ts` — the `task` tool now sees `billing` and `engineering` in its role registry.
- The LLM chose to delegate (no Floe-level triage call). It read the role descriptions Flue injected into the system prompt and picked the right one for each user question.
- `TurnMetrics.tasks.count` would equal `1` for each turn (already captured by the task-tracker shipped in commit B).
- The full flow is: host LLM call → host emits `task` tool call with `{role}` → Flue spawns a child run with that role overlay → child returns → host streams the synthesized answer.
- One LLM round-trip *per delegation* (the child) plus one host round-trip — vs. the legacy path of one triage call + one agent call. The new path has the SAME number of LLM calls for delegated cases AND ZERO triage cost for non-delegated cases (host answers directly).

## How to produce the real version

1. Replace the invalid `OPENAI_API_KEY` or `GEMINI_API_KEY` in
   `.env.local` with a working one
2. From `examples/role-spike/`:

   ```bash
   set -a && source ../../.env.local && set +a
   pnpm spike            # uses default model openai/gpt-4.1-mini
   # or override:
   FLOE_MODEL='google/gemini-3.5-flash' pnpm spike
   ```

3. The driver overwrites `conversation.md` with the real transcript.
4. Compare to this `conversation-simulated.md` — event types and
   delegation pattern should match; timings and exact text will differ.
