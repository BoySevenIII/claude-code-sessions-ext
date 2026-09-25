#!/usr/bin/env bash
# Deploy UUID-based routing over Claude Code's live process registry.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
profile="$HOME/.config/tunnel-client/CloudB-DEV-root.yaml"
unit_name=openai-tunnel-claude.service
for command in corepack node systemctl curl; do
  command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }
done
[[ -f $profile ]] || { echo 'ChatGPT tunnel profile is missing' >&2; exit 1; }
grep -Fq "$repo_root/packages/mcp/dist/index.js" "$profile" || {
  echo 'The tunnel does not use this MCP fork' >&2
  exit 1
}
for local_node in "$HOME"/.local/share/claude-sessions-live/node-v24.15.0-linux-*/bin/node; do
  if [[ -x $local_node ]]; then export PATH="$(dirname "$local_node"):$PATH"; break; fi
done

cd "$repo_root"
corepack pnpm --filter claude-sessions-mcp build
corepack pnpm --filter claude-sessions-mcp test
corepack pnpm --filter claude-sessions-mcp typecheck
systemctl --user restart "$unit_name"
for _ in {1..30}; do
  if systemctl --user is-active --quiet "$unit_name" && curl --silent --fail http://127.0.0.1:8080/readyz >/dev/null; then
    echo 'UUID routing is ready. Refresh Claude CLI tools in ChatGPT.'
    exit 0
  fi
  sleep 1
done
echo 'ChatGPT tunnel did not become ready; see its journal for details' >&2
exit 1
