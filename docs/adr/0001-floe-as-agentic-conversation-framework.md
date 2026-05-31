# ADR-0001: Floe positions as the framework for *agentic conversation*

**Status**: Accepted
**Date**: 2026-05-23
**Supersedes**: Implicit prior framing ("conversational AI harness on Flue") that conflated three different positioning lanes.

---

## Context

After ~6 months of building, Floe sits at an awkward crossroads. The codebase has accumulated primitives from three different mental models without ever picking one explicitly:

- **Coding-agent harness** (inherited from Flue): sandbox, AGENTS.md, `.agents/skills/`, just-bash, cwd, workspace, task-as-subagent
- **Multi-agent CX bot** (Floe's `defineAgent` + `agents: []` + LLM triage)
- **Stateful conversation primitive** (Conversation lifecycle, channels, handoff, inbox, transcript routes)

The recent work — Pattern C (sandbox required, opt-out), MCP wiring, task delegation telemetry, mid-turn interruption, compaction telemetry, the handoff/InboxPort, Linear adapter — has been pulling consistently in one direction without that direction being named. The "kill `defineAgent`, lean on Flue roles" insight made the misalignment explicit: we kept inventing primitives that already existed at the layer below us, because we hadn't picked a lane.

This ADR picks the lane.

## Decision

> **Floe is the TypeScript framework for *agentic conversation*** — applications where the system must both (a) maintain a stateful relationship with a human user across turns, channels, and sessions, AND (b) take real actions in external systems (CRM, ticketing, billing, internal databases, schedules) with the isolation, observability, and audit that side effects demand.

This is narrower than "conversational AI" and narrower than "agent framework." It's the intersection.

### Three lanes, and the one we're in

| Lane | Best framework today | Why Floe is wrong for it |
|---|---|---|
| **Pure chatbots** (Q&A from a knowledge base, no side effects) | Vercel AI SDK, Mastra | Floe's required sandbox + Flue's agent-shaped runtime is overhead for "stream a reply from RAG context." |
| **Pure coding agents / autonomous tasks** (Codex-style, multi-hour runs, no human in the loop) | Flue directly, Claude Code, OpenAI Agents SDK | Floe's Conversation + Channel + Handoff layer is overhead for "run until done and exit." |
| **Agentic conversation** ← we live here | *Nothing crisp yet — Mastra and Sierra/Decagon (vertical SaaS) circle this space* | This ADR claims the position. |

### What "agentic conversation" means concretely

A bot that:
- Holds **multi-turn stateful dialogue** with a named user, surviving across sessions and channels
- Takes **real, audited actions** in external systems (not just text generation) — refunds, ticket creation, calendar booking, CRM writes, code execution
- Knows when to **hand off to a human** with full context, and resume cleanly when the human hands back
- Operates across **multiple channels** for the same conversation (started on web, continued on Slack, resolved on voice)
- Maintains **lifecycle state** (active / idle / abandoned / escalated / closed) so the runtime — not the LLM — knows what to do next

Examples of products that ARE agentic conversation:
- Internal IT/HR ops bot in Slack that resets passwords, files tickets, fetches policy, escalates to on-call
- Sales SDR bot that qualifies leads, writes to CRM, books calendar holds, escalates to humans
- External CX bot that issues refunds, modifies orders, files bug tickets, escalates to humans
- Voice agent that takes appointments, reschedules, sends confirmations

Examples of products that are NOT agentic conversation:
- An FAQ widget that streams answers from a help center (no actions → pure chat → AI SDK)
- A pull-request-review bot that runs to completion and reports (no human in the loop → pure agent → Flue)
- A search box (no dialogue, no actions)

## Why Flue is the right base for this position (not the wrong one)

The question "is Flue the wrong base for human interactions?" has the wrong premise. The right question is "for *which* human interactions." For pure chat, yes Flue is overkill. For agentic conversation, Flue gives us things no chat-first framework has:

| Capability | Flue ships it | Chat frameworks (AI SDK, Mastra) |
|---|---|---|
| Sandbox isolation for tools | ✓ | ✗ — try/catch is the boundary |
| MCP at runtime | ✓ | Bolted on or absent |
| Cross-session memory via DO SQLite / R2 hydration | ✓ | ✗ — usually a memory plugin |
| Task-as-subagent for delegation | ✓ | ✗ |
| Multi-provider abstraction via pi-ai (OpenAI/Anthropic/Google/CF AI) | ✓ | Per-provider SDKs |
| Roles as system-prompt overlays with model + thinking overrides | ✓ | Manual per-call |
| Deployment targets (Node / CF Workers / CI) wired | ✓ | DIY |
| `observe()` event stream for telemetry | ✓ | ✗ — DIY |
| AGENTS.md / skill auto-discovery (when the bot has runbook docs) | ✓ | ✗ |

Action-taking is exactly what Flue's coding-agent DNA is for. We don't pay for Flue's harness; we *use* it.

## What this changes — concrete consequences

### Things we keep / double down on
1. **Sandbox required (Pattern C) is correct.** Action-taking bots need real tool isolation. The `false` opt-out exists for tests and pure-chat shims, not as the headline path.
2. **MCP, task delegation, interruption, compaction telemetry, handoff/inbox** — all the recent work is on-position. Keep building this surface.
3. **Channels as first-class** (web / Slack / voice / WhatsApp). The "same conversation, multiple channels" property is a position differentiator.
4. **Conversation lifecycle** (active / idle / abandoned / escalated / closed). This is where the *runtime* makes decisions instead of asking the LLM.
5. **Validators + TurnMetrics observability digest.** Action-taking demands per-turn audit; this is where we differ from chat frameworks that only count tokens.

### Things we kill (or have already killed)
1. **`defineAgent` + `agents: []` + LLM-driven triage.** These reinvent Flue roles + the `task` tool. Migration path: replace with `conversation.systemPrompt: string` + `conversation.roles: Record<string, Role>` per [the prior discussion]. (Separate ADR will track the destruction.)
2. **The phrase "harness" in user-facing docs.** Flue is the harness. Floe is the conversation framework. Users see Floe vocabulary only.
3. **"Sub-agent" as a Floe primitive.** Flue already gives `task({role, prompt})`; we don't bundle it into a `defineSubAgent` until real use demands it.

### Things we explicitly do NOT build
1. **A visual flow builder.** Not the audience. Voiceflow / Botpress already serve "no-code conversation."
2. **A managed hosting product.** Floe is a framework; runtime hosting is Flue's job (Node / CF / etc.).
3. **A proprietary knowledge ingestion pipeline.** RAG is solved enough; we expose pluggable knowledge sources (hybridKnowledge, workspaceBm25) and let users bring their own embedders/vector stores.
4. **CX-vertical UI components.** Floe ends at the API boundary. Frontends use Vercel AI SDK's `useChat` or whatever they want.
5. **A multi-agent "swarm" abstraction beyond what Flue's `task` gives us.** No CrewAI-style orchestration layer.

### Things we hide (Flue leakage to address)
1. `init({sandbox, cwd})` shape should not appear in `floe.config.ts` — Floe should accept a Flue-agnostic sandbox config and translate.
2. The `turn` vocabulary collision (Flue's turn = one LLM round-trip; Floe's turn = one user-bot exchange). Pick one in docs, alias the other in code.
3. `harness`, `instance`, `operation`, `agent` (Flue's HTTP-deployable handler) — none of these belong in Floe's public docs.

## Alternatives considered

### Alt 1: Position as a general conversation framework (Mastra-shaped)
- **Why rejected**: Mastra is already there, has 6 months head start, larger ecosystem. We'd be a worse Mastra. Our work to date (sandbox, MCP, task delegation, action-side primitives) wouldn't be the differentiator.

### Alt 2: Position as a CX-specific framework (Fin alternative)
- **Why rejected**: CX SaaS (Fin, Decagon, Sierra) wins this market. The framework buyers in CX are tech-led teams that want a SDK, and they'll pick AI SDK + custom over a CX-flavored framework. "Framework for building Fin" is too narrow a wedge.

### Alt 3: Drop Flue, rebuild on Vercel AI SDK
- **Why rejected**: We'd reimplement sandbox, MCP, observability, model resolution, deployment, task delegation, role primitives. That's 6+ months of work to arrive at "Mastra-but-newer." Flue's harness is genuinely the right substrate for the action-taking half of agentic conversation.

### Alt 4: Stay generic ("framework for stateful conversation")
- **Why rejected**: This is the default, and it's what brought us to the awkward crossroads in the first place. Generic positioning means every PR's scope is debatable. Naming the lane is the filter.

## Open questions (deferred, not blocking)

1. **Wedge use case for v1**: internal ops bot vs external CX bot vs voice agent. Leaning toward internal ops (less competitive, more obvious tool-action overlap), but worth a separate decision.
2. **How aggressively to hide Flue**: full opaque (users never import from `@flue/runtime`) vs translucent (users can import Flue primitives for power use). Currently translucent; may move toward opaque if it causes confusion in user feedback.
3. **Whether to ship a `defineSubAgent` convenience after killing `defineAgent`**: same question phrased differently. Defer until ≥3 real users report friction with raw `task({role, prompt})`.
4. **Visual lifecycle UI** (the inbox dashboard): is that a Floe-shipped reference UI or a third-party concern? Likely third-party, but worth deciding before someone PRs it.

## The filter this ADR creates

For every future PR, the question is: **does this serve agentic conversation specifically?**

- A new primitive for "audit trail of every tool call with cost attribution" — **yes**, that's action-taking observability.
- A new primitive for "branching conversation trees with what-if forks" — **yes**, that's stateful conversation.
- A new chunker for legal PDFs — **no**, that's vertical-CX work; users can implement.
- A new visual flow builder — **no**, wrong audience.
- A wrapper around OpenAI's Realtime API — **maybe**, only if it serves voice as a Floe channel (yes) vs. as a Floe primitive (no).
- A second multi-agent orchestration layer beyond Flue `task` — **no** unless real users demand it.

## What this means for the open CF tasks (#66-68)

CF deploy goes from "we have to ship this" to "we ship this when an agentic-conversation user needs it." It's still on the roadmap (CF Workers is a legitimate deployment target for the position), but it's not a blocker for v1 positioning. We use `flue build --target cloudflare` when we get there; don't hand-roll.

## What this means for the current code

No code changes required by this ADR — it codifies what the work has already converged on. The follow-up ADRs (kill `defineAgent`, kill triage, hide Flue's `init` shape) are the destruction-led migrations this position implies.

---

**Reaffirmation cadence**: review this ADR at v1 release. If `defineAgent` is still in the codebase or Flue's vocabulary still leaks into user docs at that point, the position is failing and we need to either fix the code or reopen the decision.

## Reaffirmed at v1 — 2026-05-23

- `defineAgent` is **deleted**. `defineConversation` is **deleted**.
  `runTriage` + `triage.ts` are **deleted**. `ConversationAgent` /
  `agents[]` / `triage` / `defaultAgentId` / `activeAgentId` /
  `triagedAt` / `triageVersion` / `agent_handed_off` /
  `triage_decision` events / `TurnMetrics.{triage, agentId,
  conversation}` are all **deleted**. Verified by grep at commit time.
- `Assistant` is the named primitive. `mode: 'direct' | 'route' |
  'coordinate' | 'broadcast'` is the coordination vocabulary.
  `Assistant.run(message, args)` returns a `TurnHandle`.
- Flue's `task` tool sidestepped via Floe's own `delegate(role,
  prompt)` tool — coordinate mode works end-to-end (live-verified
  against OpenAI in `examples/role-spike/`).
- Channels: only `webChat` shipped in core. Slack + voice channel
  modules **deleted**. BYO adapters per BLUEPRINT §6.
- README rewritten around the new shape (mode, subpath imports, no
  `floe.*` runtime namespace).
- 224/224 runtime tests pass. tsc clean.

The position holds. The deletion is durable.
