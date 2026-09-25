#!/usr/bin/env bash
# Register a local Claude Code channel, then rebuild the existing ChatGPT bridge.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
unit_name=openai-tunnel-claude.service
profile="$HOME/.config/tunnel-client/CloudB-DEV-root.yaml"
for command in claude corepack node systemctl curl; do
  command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }
done
[[ -f $profile ]] || { echo 'ChatGPT tunnel profile is missing' >&2; exit 1; }
grep -Fq "$repo_root/packages/mcp/dist/index.js" "$profile" || {
  echo 'The tunnel does not use this MCP fork' >&2
  exit 1
}

node_bin=$(command -v node)
for local_node in "$HOME"/.local/share/claude-sessions-live/node-v24.15.0-linux-*/bin/node; do
  if [[ -x $local_node ]]; then
    node_bin=$local_node
    export PATH="$(dirname "$node_bin"):$PATH"
    break
  fi
done

cd "$repo_root"
corepack pnpm --filter claude-sessions-mcp build
corepack pnpm --filter claude-sessions-mcp test
corepack pnpm --filter claude-sessions-mcp typecheck

channel="$repo_root/packages/mcp/dist/claude-channel.js"
[[ -f $channel ]] || { echo 'Claude channel build is missing' >&2; exit 1; }
if claude mcp get chatgpt-channel >/dev/null 2>&1; then
  echo 'Claude MCP server chatgpt-channel already exists; inspect it before changing its configuration' >&2
  exit 1
fi
claude mcp add --scope user --transport stdio chatgpt-channel -- "$node_bin" "$channel"

systemctl --user restart "$unit_name"
ready=0
for _ in {1..30}; do
  if systemctl --user is-active --quiet "$unit_name" && curl --silent --fail http://127.0.0.1:8080/readyz >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
if (( ! ready )); then
  echo 'ChatGPT tunnel did not become ready after the MCP rebuild' >&2
  exit 1
fi

echo 'Bridge and Claude channel are installed.'
echo 'In Claude Code, exit the current session and restart it with:'
echo '  claude --resume <current-claude-session-uuid> --dangerously-load-development-channels server:chatgpt-channel'
echo 'Then refresh tools in the ChatGPT Claude CLI app to discover send_to_claude_session.'
