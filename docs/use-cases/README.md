# Use-case walkthroughs

Concrete, code-shaped walkthroughs of building agentic-conversation
apps with Floe, per the positioning in [`docs/adr/0001-floe-as-agentic-conversation-framework.md`](../adr/0001-floe-as-agentic-conversation-framework.md).

Each doc is paired with a runnable template under [`templates/`](../../templates/).
Use the doc to understand the SHAPE; clone the template to start
building.

| # | Use case | Channels | Wedge | Template |
|---|---|---|---|---|
| [01](01-internal-ops-bot.md) | Internal IT/HR ops bot (Acme) | Slack + Web | B2B internal | [`templates/ops-bot/`](../../templates/ops-bot/) |
| [02](02-b2c-subscription-bot.md) | Meal-kit subscription support (Hearth) | Voice + Web | B2C retention | [`templates/hearth-bot/`](../../templates/hearth-bot/) |
| [03](03-b2c-clinic-bot.md) | Healthcare clinic assistant (Cedar Health) | Voice + Web | B2C high-stakes | [`templates/cedar-health/`](../../templates/cedar-health/) |

## Conventions

- ✅ — primitive shipped today
- 🔜 — aspirational; needs the v1 BLUEPRINT migration (`defineAgent` deletion → Flue roles)
- 🌳 — wired but unused in shipped examples

If a doc uses a primitive marked 🔜, the code shape will change before
the example is built. The intent doesn't change; the API call sites do.

## How to use these docs

1. **Read ADR-0001 first.** The positioning explains why these are the
   chosen lighthouses (vs. CX bots, vs. coding agents, vs. pure chat).
2. **Pick one** based on what your work most resembles. The three cover
   different stakes / channel mixes / handoff patterns.
3. **Read the "runtime vs LLM" table** in each — that's where the
   "don't make the LLM do everything" philosophy is concretized.
4. **Read "where Floe stops"** — the framework is honest about its
   boundary; you bring auth, hosting, the actual business APIs (via MCP),
   the UI components, and the speech engine.
