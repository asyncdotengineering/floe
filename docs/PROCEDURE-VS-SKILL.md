# Procedure (Floe) vs Skill (Flue) — design evaluation

**Question (raised this session):** Does Flue already ship the `Procedure` primitive (as `Skill`)? Can we delete Floe's procedure-loader and use Flue's directly?

**Answer:** No. They're different primitives with overlapping markdown-on-disk shape but fundamentally different semantics. Floe's `Procedure` stays. This doc records why so the question doesn't re-surface.

---

## Side-by-side

|  | Flue `Skill` | Floe `Procedure` |
|---|---|---|
| **What it is** | A named action the model can INVOKE (an instruction macro) | A passive policy INJECTED into the prompt when topic matches |
| **Discovery** | Convention: `.agents/skills/<name>/SKILL.md` auto-loaded at `init()` time | Explicit: `defineProcedure('procedures/refund-policy.md')` references it |
| **Trigger model** | Model decides — sees skill in "## Available Skills" registry, calls `session.skill(name)` when it judges relevant | Orchestrator decides — `triggers: ['refund', 'money back']` keyword-match against user message; matched body injected into system prompt |
| **Body lifecycle** | Read from disk EVERY invocation (relative refs inside skill stay resolvable from skill's dir) | Read once on first activation, cached on the Procedure object |
| **System-prompt presence** | Name + description only ("## Available Skills" registry) | Full body of every matched procedure inlined |
| **Workflow shape** | Active — "do this thing" | Passive — "follow these rules when answering this topic" |
| **Frontmatter** | `name`, `description` | `name`, `triggers`, `escalate-when` |
| **Source** | `repo/flue/packages/runtime/src/context.ts:98-131` `discoverLocalSkills()` | `packages/runtime/src/procedure-loader.ts` `loadProcedure()` |

## What a Skill replaces

If your agent has a multi-step task like "summarize this PR following our checklist," that's a **Skill** — the model invokes it as an action, reads the markdown body, executes the steps.

## What a Procedure replaces

If your agent has a tone constraint, escalation rule, or compliance policy that should silently shape EVERY refund-related reply, that's a **Procedure** — orchestrator detects the topic, injects the policy into the system prompt, model just naturally follows it.

## Could we layer Procedures on Skills?

Theoretically yes — `defineProcedure(path)` could put markdown under `.agents/skills/refund-policy/SKILL.md` and Flue would auto-discover it. But:

1. We lose the trigger model (Skills don't have keyword triggers; the model decides if/when to invoke)
2. We lose the silent-injection semantics (Skills become tools the model calls explicitly — visible in the conversation, not transparently applied)
3. Users would have to write `<refund-policy>` invocation prompts, breaking the "policy just applies" abstraction

Not worth it. The two primitives serve different jobs.

## Could we ALSO support Skills alongside Procedures?

Yes — and Flue already auto-discovers them when the agent has a `.agents/skills/` dir under its `cwd`. So **Skills work out-of-the-box today** (since we just plumbed `init({cwd})` properly — see `packages/runtime/src/orchestrator/prepare-turn.ts`). Any user putting `.agents/skills/foo/SKILL.md` in their project gets them registered in the system prompt for free.

We don't ship a Floe-level wrapper around Skills because we don't need to — they're already available via the underlying Flue session. The orchestrator gets them for free as part of harness initialization.

## Decision

- **Keep `Procedure` as a Floe-owned primitive.** Different purpose; can't be subsumed.
- **Expose nothing new for Skills.** Flue's auto-discovery handles them as soon as `.agents/skills/` exists in the workspace cwd.
- **No deletion or rename of `procedure-loader.ts`.**

This evaluation closes follow-up #2 from the prior session-end report.

## Reaffirmed 2026-05-23

Re-checked during the harness-gaps push (A+B+C+E+G). Verified:

- `repo/flue/packages/runtime/src/context.ts:98` `discoverLocalSkills()` still exists in Flue 0.7 and is called automatically during harness init. Skills under `.agents/skills/<name>/SKILL.md` work without any Floe-level wiring — confirmed via grep of the Flue runtime source.
- No Floe example currently ships a `.agents/skills/` directory. When a user wants to add one (e.g., a "summarize-transcript" skill the LLM can invoke), it just works — no new export, no glue code, no migration.
- Procedure shape unchanged: triggers/escalate-when frontmatter, orchestrator-driven trigger matching, body injected into system prompt.

The two primitives remain orthogonal. No follow-up scheduled.
