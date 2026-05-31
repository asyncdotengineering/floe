# mcp-bot

Demonstrates an MCP-tool-using Floe agent. `floe.config.ts` declares one MCP
server (`inventory`); `mcp-stub-server.ts` is a tiny local implementation
that exposes `lookup_sku`. The agent calls it as `mcp__inventory__lookup_sku`.

## Run

```bash
pnpm stub &                   # start stub MCP server on :3201
pnpm dev                      # start the Floe server on :3000
```

Then send a turn:

```bash
curl -sN -X POST http://localhost:3000/agents/web/conv-1 \
  -H 'content-type: application/json' \
  -d '{"message": "How many SKU-003 do we have?"}'
```

The agent should call `mcp__inventory__lookup_sku({sku: "SKU-003"})` and
respond with "117 in stock at $24."

## Pointing at a real MCP server

Set `MCP_INVENTORY_URL` to any production MCP endpoint (GitHub, Linear,
Slack, Notion) and edit the system prompt + tool-name expectations.

## Failure handling

If the MCP server is down, the agent boots fine — the conversation just
runs without those tools. Check the orchestrator logs for `[floe/mcp]
connect failed for "inventory"`.
