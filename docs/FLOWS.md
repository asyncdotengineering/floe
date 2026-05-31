# Flows in Floe

A **flow** is a structured, multi-turn procedure your assistant runs to accomplish a specific task — collecting information, looking something up, asking for confirmation, executing a side-effect, replying with the outcome. Flows are how you stop trusting the LLM with state, control flow, and business logic, while still letting it handle natural language at the edges.

This document walks through Floe's flow primitives, how they compose, and how to author one end-to-end. The examples reference `examples/ecommerce-bot/flows/return.ts`, which is the canonical end-to-end flow in this repo.

---

## Why flows

A "regular" tool-calling agent has one giant LLM call that decides what to do, calls tools, then talks to the user. That works for short, single-turn things. It breaks down when:

- The task spans multiple turns and you need to remember partial state across them.
- A step is deterministic and shouldn't be subject to LLM variance (eligibility math, lookups, side-effects after explicit confirmation).
- Different paths through the task need different output rules (the "approved" reply must contain the order id and amount; the "denied" reply must offer two specific alternatives).
- You want assertion-friendly behavior: you want to test "did the assistant take the denial branch?" not "did the assistant say the right thing?".

Flows solve this by splitting a task into a small graph of typed nodes, where each node has one explicit responsibility.

---

## The four node kinds

Floe has exactly four node kinds. Every flow is a graph of these:

| Kind            | Has LLM call? | Purpose                                                                 |
| --------------- | ------------- | ----------------------------------------------------------------------- |
| **Extraction**  | Yes (loops)   | Collect typed fields from the user across one or more turns.            |
| **Capture**     | Yes (1 shot)  | Classify a single user message into a typed result (e.g. yes / no).     |
| **Compute**     | No            | Deterministic business logic. Lookups, math, side-effects, branching.   |
| **Reply**       | Yes (1 shot)  | Produce user-facing text with strict output rules.                      |

Why four and not three or five? Each one corresponds to a distinct *capability* the LLM either has or shouldn't have:

- **Extraction** is the only place that loops — the model gets to re-ask until required fields are filled.
- **Capture** is the only place a model translates one user utterance into a single typed value — no loop, no reply.
- **Compute** is the only place with no model call at all. If your "logic" needs an LLM, it's a Capture (classify) or a Reply (render), not a Compute.
- **Reply** is the only place text is produced for the user. It runs in a fresh child session with `tools: []` so there's no surprise tool-calling and no context bleed from earlier turns.

This is a strict partition. If you reach for "an Extraction that also responds," you actually want an Extraction followed by a Reply — split them.

---

## Anatomy of a flow

```ts
import { defineFlow } from '@floe/runtime';

export const returnFlow = defineFlow({
  name: 'return',
  description: 'Multi-step return … triggered when a customer asks to return …',
  startNode: () => collectOrder,
});
```

Two fields matter:

- **`name`** — used in observability events (`enteredFlow('return')`) and as the routing key.
- **`description`** — the LLM uses this to decide whether to enter the flow. It becomes the description of the auto-generated `enter_return` tool. Write it as a *trigger condition*, not a feature description: "Triggered when a customer asks to return, refund, or send back an item from a specific order."

Flow entry is multilingual by construction — the assistant decides to call `enter_return` based on intent, not surface-form. Don't write language-specific hints into the description; you'll regress non-English users.

---

## Extraction nodes

Collect typed data from the user, retrying as needed until the required fields are present.

```ts
const collectOrder = defineExtractionNode({
  name: 'collect-order',
  prompt: `You are collecting two pieces of information from the customer …
    - orderId — in the format ord_NNNN
    - statedReason — a short summary of why they want to return …`,
  schema: v.object({
    orderId: v.string(),
    statedReason: v.string(),
  }),
  requiredFields: ['orderId', 'statedReason'],
  async onComplete({ orderId, statedReason }, ctx) {
    ctx.state.orderId = orderId;
    ctx.state.statedReason = statedReason;
    return { kind: 'node', node: lookupOrder };
  },
});
```

What's happening under the hood:

1. Floe exposes a tool `submit_collect_order_data` to the model. The user's most recent message is inlined verbatim into the tool's description — so the model sees the actual user utterance in the same place it'd see any other context, in whatever language the user wrote it.
2. The model calls that tool with the fields it could extract. Partial submits are fine — Floe merges them into the flow's data bag.
3. If any `requiredFields` are still missing after the call, Floe re-prompts the model with a new tool that includes only the still-missing fields, plus the user's next reply.
4. If the model calls the submit tool with all-null/all-empty args (a no-progress submission), Floe retries *once* with a nudge variant: "your previous submit call produced no field values — do NOT call this tool with empty args, ask the user instead." This catches the common failure where a model dutifully submits without actually extracting anything.
5. When all required fields are present, `onComplete` runs. It receives the typed values and the flow context (`ctx.state` is the flow's mutable data bag). Return a `Transition` to specify the next node.

A few practical notes:

- The `prompt` is the *instructions to the extractor* — what the fields mean, what valid phrasings look like, what to do if only one field is provided. The user's actual message arrives via the inlined tool description; don't try to reconstruct it inside `prompt`.
- Use a Valibot `schema` to constrain field types. Floe enforces this strictly; an extraction that doesn't match the schema is treated as no-progress and triggers the retry path.
- `requiredFields` controls when `onComplete` fires. Optional fields can be in `schema` but absent from `requiredFields` — they'll be collected if the user mentions them, but won't block completion.

---

## Capture nodes

Classify a single user message into one typed result. No looping, no reply.

```ts
const captureConfirmation = defineCaptureNode({
  name: 'capture-confirmation',
  prompt: `# Task
The customer's last message is a reply to "Shall I confirm and process the refund?" Classify it.

# Classification rules
- Confirmed (confirmed: true): "yes", "sure", "go ahead", "proceed", …
- Declined (confirmed: false): "no", "wait", "cancel", "not now", …
- Ambiguous: confirmed: false for safety.`,
  schema: v.object({ confirmed: v.boolean() }),
  async handler({ confirmed }, ctx) {
    if (!confirmed) return { kind: 'node', node: returnDeclined };
    return { kind: 'node', node: processRefund };
  },
});
```

Use Capture when the user has just been asked a focused question (yes/no, a multi-choice, a small enum) and you need a *typed* answer to branch on. The model emits ONLY the structured result — no user-facing text. Whatever the model says next is decided by the node `handler` returns, not by the model.

The classic shape: Reply (ask the question, end the turn) → next turn → Capture (classify the answer) → branch.

---

## Compute nodes

No LLM. Pure business logic. Lookups, math, side-effects after confirmation, branching on deterministic conditions.

```ts
const lookupOrder = defineComputeNode({
  name: 'lookup-order',
  compute(ctx) {
    const orderId = ctx.state.orderId as string;
    const order = ORDERS[orderId];
    if (!order) {
      ctx.state.lookupError = 'order_not_found';
      return { kind: 'node', node: orderNotFound };
    }
    const e = computeReturnEligibility(order.totalUsd, order.ageDays);
    ctx.state.refundAmountUsd = e.refundAmountUsd;
    ctx.state.refundType = e.refundType;
    if (!e.eligible) return { kind: 'node', node: explainDenial };
    return { kind: 'node', node: askConfirmation };
  },
});
```

What lives in Compute:

- Lookups against your own data (`ORDERS[orderId]`, a database query, a fetch to an internal API).
- Math (refund amount, eligibility window, totals).
- Branching on the results of the above.
- Side-effects you don't want the model to skip or improvise (e.g. actually processing the refund after the user said yes).

What does NOT live in Compute:

- Anything that requires understanding natural language. That's Extraction (collect) or Capture (classify).
- Writing user-facing text. That's Reply.

The hard rule: if you write a Compute node that calls an LLM, you've made a mistake. Split it.

---

## Reply nodes

Produce user-facing text under strict rules, in a fresh child context with `tools: []`.

```ts
const askConfirmation = defineReplyNode({
  name: 'ask-confirmation',
  prompt: (ctx) => {
    const s = ctx.state;
    return `You are an Acme Threads concierge. Tell the customer their return is approved …

# Output rules (STRICT)
- First sentence: state eligibility + amount. MUST contain the literal "${s.orderId}" AND "$${s.refundAmountUsd}".
- Second sentence: ask for confirmation. MUST be exactly one of:
  - "Shall I confirm and process the refund?"
  - "Would you like me to confirm and process the refund?"
  - "Want me to confirm and process the refund?"
- No closing remarks, no extras.`;
  },
  next: () => ({ kind: 'node', node: captureConfirmation }),
});
```

Three things to understand about Reply nodes:

1. **The prompt is a function of `ctx.state`.** This is where you inject flow-collected data (`orderId`, `refundAmountUsd`, `eligibilityReasoning`) into the user-facing message. Don't expect the model to remember it from earlier — interpolate it.

2. **Strict output rules.** Reply nodes are where you nail down the contract: required literals, required phrasings, forbidden words. The downstream Capture (in the next turn) and your bench assertions both depend on the reply landing in a predictable shape. Be specific. "Must contain `${s.orderId}` and `$${s.refundAmountUsd}`" is a real constraint; "be friendly" is not.

3. **`next` is what happens AFTER the reply.** A Reply node ends the current turn — it sends text to the user. `next` is the transition that fires when the user replies on the next turn.

   - `next: { kind: 'end', reason: '…' }` — flow ends, the assistant returns to general handling.
   - `next: () => ({ kind: 'node', node: captureConfirmation })` — when the user replies, run `captureConfirmation` on their message. Note the **thunk** form: `() => …` lets you reference a node defined later in the file without ordering pain.

---

## Forward declarations

Flows are cyclic graphs and TypeScript modules are linear. You'll need forward references. The pattern is:

```ts
let captureConfirmation: ReturnType<typeof defineCaptureConfirmation>;
// … later …
function defineCaptureConfirmation() {
  return defineCaptureNode({ … });
}
captureConfirmation = defineCaptureConfirmation();
```

This works for `next` and `onComplete` transitions because `Transition` is evaluated lazily. For Reply nodes, you can also wrap `next` in a thunk:

```ts
next: () => ({ kind: 'node', node: captureConfirmation }),
```

The thunk fires at transition time, not at definition time, so the forward-declared variable is bound by then.

---

## A complete flow, end to end

The return flow in `examples/ecommerce-bot/flows/return.ts` is the canonical worked example. Its shape:

```
T0 user:    "I want to return ord_2240 — the fit was wrong."

  collect-order (Extraction)
    → submits {orderId: 'ord_2240', statedReason: 'fit was wrong'}
    → onComplete → lookup-order

  lookup-order (Compute — no LLM)
    → ORDERS['ord_2240'] → 27 days old, $189
    → computeReturnEligibility → eligible: true, $189 refund
    → ask-confirmation

  ask-confirmation (Reply — ends T0)
    → "order ord_2240 is within our 30-day window … Shall I confirm and process the refund?"

T1 user:    "yes, please process it"

  capture-confirmation (Capture)
    → classify → confirmed: true
    → process-refund

  process-refund (Compute)
    → calls processReturnTool → returnId: rtn_abcd1234
    → refund-confirmed

  refund-confirmed (Reply — ends flow)
    → "Done — refund rtn_abcd1234 for $189 on order ord_2240 has been processed."
```

Three branches off `lookup-order`:

- Order eligible (≤30 days) → full refund → `ask-confirmation`.
- Order eligible (31–90 days) → 50% store credit → `ask-confirmation` (same node, different copy via interpolated `refundType`).
- Order ineligible (>90 days) → `explain-denial` (no confirmation needed; flow ends).
- Order not found → `order-not-found` (flow ends).

Every branch returns text under strict rules. Every reply that ends the flow uses `next: { kind: 'end', reason: '…' }`. The `reason` becomes an observability marker so you can tell *why* a flow ended in traces.

---

## Wiring a flow into an assistant

```ts
import { defineFloe } from '@floe/runtime';
import { returnFlow } from './flows/return.ts';

export default defineFloe({
  name: 'concierge',
  agents: [{ id: 'concierge', flows: [returnFlow], … }],
});
```

That's it. Floe generates an `enter_return` tool from the flow's `description`. When the agent calls it (because the user expressed return intent), Floe pushes a flow frame onto the session, runs `startNode`, and dispatches based on node kind. The flow ends when a Reply node has `next: { kind: 'end', … }` (or when something explicit interrupts it).

---

## Testing flows

Floe's eval framework gives you four assertions that are flow-aware:

```ts
import {
  enteredFlow,
  mentionsNode,
  semanticContains,
  semanticMatches,
} from '@floe/runtime/eval';
```

- **`enteredFlow('return')`** — asserts the assistant routed to the named flow on this turn. Use this when you care that triage worked correctly, separate from what the assistant said.
- **`mentionsNode('explain-denial')`** — asserts a specific node ran. Use this when you care about which branch the flow took (`explain-denial` vs `ask-confirmation`).
- **`semanticContains(needle, { intent, judge })`** — literal substring check first; if it misses, an LLM judge sees the reply + the stated `intent` and decides whether the reply *actually* satisfies the intent under a different surface form ("sizing" vs "size"). This is what you reach for when the literal check is right 95% of the time and you don't want surface-form drift to fail real PASSes.
- **`semanticMatches(regex, { intent, judge })`** — same idea for regex.

The semantic variants take a `judge: JudgeFn` callable. Wire it once at bench startup against whichever LLM you want — see `examples/ecommerce-bot/test/bench.test.ts` for an OpenAI direct-fetch judge.

For deterministic cases, the plain `contains` / `notContains` / `matches` are still right. Reach for the semantic variants when (a) the assertion is testing a *concept* the model might phrase differently across runs, or (b) you're seeing flaky failures that turn out to be legitimate paraphrases.

---

## Common shapes

A small library of patterns that come up repeatedly:

**Single-turn structured intake** — Extraction → Compute → Reply (end).
The simplest useful flow. User gives info, you look something up, you reply with the result.

**Confirmation gate before side-effect** — Extraction → Compute → Reply (ask) → next turn → Capture (yes/no) → Compute (do it) → Reply (done) | Reply (declined).
The shape of the return flow. Never call a side-effect tool from a Compute node unless an upstream Capture has confirmed.

**Branching on deterministic policy** — Extraction → Compute (with policy logic) → one of N Reply nodes.
Eligibility windows, account-tier branches, threshold checks. Keep the policy in Compute, not in a Reply prompt.

**Multi-turn extraction with policy validation** — Extraction (loop) → Compute (validate) → Reply (re-ask via flow restart) | Reply (proceed).
When some fields are only knowable after extraction completes (e.g. "this user doesn't own that account"), don't try to validate inside the Extraction prompt. Extract first, validate in Compute, branch.

---

## Pitfalls

A short list of mistakes that show up in code review:

- **Putting business logic in a Reply prompt.** "If the order is over $100, mention free returns; otherwise mention …" — that's branching, it belongs in Compute, with two distinct Reply nodes.

- **Re-asking inside a Reply.** Replies don't loop. If you need more info, that's an Extraction. If you need to confirm, that's a Reply followed by a Capture on the next turn.

- **A Compute that "just calls a quick LLM."** No. Compute has no LLM. Promote it to a Capture (if you need to classify the user) or a Reply (if you need text). If neither fits, the work probably isn't model-shaped — make it deterministic.

- **Forgetting the thunk on `next`.** `next: { kind: 'node', node: captureConfirmation }` evaluates `captureConfirmation` *at flow construction time*, which is `undefined` if `captureConfirmation` is defined further down. Use `next: () => ({ kind: 'node', node: captureConfirmation })`.

- **Regex hints in `description`.** The flow `description` is the trigger condition the LLM uses to route. Don't write English-specific patterns or example phrases — you'll silently regress non-English users. Describe the *intent* ("customer asks to return / refund / send back …"), not the surface form.

- **Asserting a Reply's exact wording.** The model's wording will drift across runs and across models. Either pin a literal you *truly* require (the order id, the price, "processed") and use `contains`, or assert the concept with `semanticContains` and the judge. Brittle regexes are technical debt.

- **State leakage.** `ctx.state` is the flow's data bag. Read what was set upstream, write what downstream nodes need. Don't reach into the assistant's transcript or the parent session from inside a flow node — the flow should be self-contained.

---

## When NOT to use a flow

A flow is overhead. Don't reach for one when:

- The task is a single turn with no branching ("what's our return policy?" — that's a RAG hit, not a flow).
- The model already handles it reliably with the right tools and a clear system prompt.
- You'd end up with a one-node flow whose only node is a Reply. Just answer.

Flows pay off when you have *state* that needs to survive a turn boundary, or *branching* that needs to be deterministic, or *side-effects* that need a confirmation gate. If you don't have any of those, you don't need a flow.
