#!/usr/bin/env bash
# Build the UUID bridge and point the existing OpenAI Tunnel at this fork.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
profile="$HOME/.config/tunnel-client/CloudB-DEV-root.yaml"
unit_name=openai-tunnel-claude.service
server="$repo_root/packages/mcp/dist/index.js"
old='command: "npx -y claude-sessions-mcp"'
profile_changed=0
backup=

rollback() {
  status=$?
  if (( status != 0 && profile_changed )); then
    echo "Installation failed; restoring the previous tunnel profile." >&2
    cp -p "$backup" "$profile"
    systemctl --user restart "$unit_name" || true
  fi
}
trap rollback EXIT

for command in corepack node systemctl curl python3 readlink; do
  command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }
done
[[ -f $profile ]] || { echo 'ChatGPT tunnel profile is missing' >&2; exit 1; }

# Keep the same Node 24 runtime installed by install-live-bridge.sh.
for local_node in "$HOME"/.local/share/claude-sessions-live/node-v24.15.0-linux-*/bin/node; do
  if [[ -x $local_node ]]; then export PATH="$(dirname "$local_node"):$PATH"; break; fi
done
node_bin=$(readlink -f "$(command -v node)")
"$node_bin" -e 'const [major,minor,patch]=process.versions.node.split(".").map(Number); process.exit((major===22&&(minor>22||(minor===22&&patch>=2)))||(major===24&&minor>=15)||major>=26 ? 0 : 1)' || {
  echo 'Node 22.22.2+, 24.15.0+, or 26+ is required; install the local runtime first' >&2
  exit 1
}

cd "$repo_root"
corepack pnpm --filter claude-sessions-mcp build
corepack pnpm --filter claude-sessions-mcp test
corepack pnpm --filter claude-sessions-mcp typecheck
[[ -f $server ]] || { echo 'MCP server build is missing' >&2; exit 1; }

# Verify the built MCP entry advertises the UUID tools before changing the tunnel.
(cd "$repo_root/packages/mcp" && "$node_bin" --input-type=module <<'JS'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const client = new Client({ name: 'uuid-routing-installer', version: '1.0.0' })
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'] }))
  const names = new Set((await client.listTools()).tools.map((tool) => tool.name))
  for (const required of ['list_active_claude_sessions', 'send_to_claude_session', 'read_live_conversation']) {
    if (!names.has(required)) throw new Error(`Built MCP server is missing ${required}`)
  }
} finally {
  await client.close()
}
JS
)

if grep -Fq "$server" "$profile"; then
  echo 'Tunnel profile already points to this MCP fork.'
elif grep -Fq "$old" "$profile"; then
  backup="${profile}.before-uuid-routing.$(date -u +%Y%m%dT%H%M%SZ)"
  cp -p "$profile" "$backup"
  profile_changed=1
  export UUID_ROUTING_PROFILE="$profile" UUID_ROUTING_NODE="$node_bin" UUID_ROUTING_SERVER="$server"
  python3 - <<'PY'
import json
import os
from pathlib import Path

profile = Path(os.environ['UUID_ROUTING_PROFILE'])
original = profile.read_text()
old = 'command: "npx -y claude-sessions-mcp"'
if original.count(old) != 1:
    raise SystemExit('Expected exactly one upstream MCP command; profile left unchanged')
new = 'command: ' + json.dumps(os.environ['UUID_ROUTING_NODE'] + ' ' + os.environ['UUID_ROUTING_SERVER'])
temporary = profile.with_suffix(profile.suffix + '.tmp')
temporary.write_text(original.replace(old, new, 1))
temporary.chmod(profile.stat().st_mode & 0o777)
temporary.replace(profile)
PY
  echo "Tunnel profile migrated; previous version: $backup"
else
  echo 'Tunnel profile uses an unrecognized MCP command; leave it unchanged and inspect mcp.commands.' >&2
  exit 1
fi

systemctl --user restart "$unit_name"
for _ in {1..30}; do
  if systemctl --user is-active --quiet "$unit_name" && curl --silent --fail http://127.0.0.1:8080/readyz >/dev/null; then
    profile_changed=0
    trap - EXIT
    echo 'UUID routing is ready. Refresh Claude CLI tools in ChatGPT and open a new chat.'
    exit 0
  fi
  sleep 1
done
echo 'ChatGPT tunnel did not become ready; see its journal for details' >&2
exit 1
