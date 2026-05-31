#!/usr/bin/env bash
# agent-browser end-to-end smoke for Floe Studio.
# Prereqs:
#   - ops-bot (or any Floe template) running on $FLOE_AGENT_URL (default 3110)
#   - studio dev server running on http://localhost:3700
#   - agent-browser CLI installed globally (`npm i -g agent-browser`)
#   - `agent-browser install` ran once (downloads Chrome for Testing)
#
# Writes 4 screenshots to apps/studio/.agent-browser-spike/.
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
OUT_DIR="$SCRIPT_DIR/../.agent-browser-spike"
mkdir -p "$OUT_DIR"

echo "→ open"
agent-browser open http://localhost:3700
sleep 2

echo "→ accessibility snapshot"
agent-browser snapshot -i | head -40

echo "→ screenshot empty"
agent-browser screenshot "$OUT_DIR/01-empty.png"

echo "→ click suggestion (ref=e6 = 'Look up alice…' in default layout)"
agent-browser click @e6
sleep 1
agent-browser screenshot "$OUT_DIR/02-clicked-suggestion.png"

echo "→ wait for LLM stream"
sleep 8
agent-browser screenshot "$OUT_DIR/03-ai-replied.png"

echo "→ click New chat (ref=e2)"
agent-browser click @e2
sleep 1
agent-browser screenshot "$OUT_DIR/04-new-chat.png"

echo
echo "Captured frames:"
ls -1 "$OUT_DIR/"
