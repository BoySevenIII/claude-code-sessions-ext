#!/usr/bin/env bash
# Upgrade an installed single-session bridge to select Claude panes per call.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
profile="$HOME/.config/tunnel-client/CloudB-DEV-root.yaml"
unit_name=openai-tunnel-claude.service
dropin="$HOME/.config/systemd/user/${unit_name}.d/90-live-bridge.conf"

for command in systemctl curl corepack; do
  command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }
done
[[ -f $profile && -f $dropin && -f "$repo_root/packages/mcp/dist/index.js" ]] || {
  echo 'Installed live bridge profile, drop-in, or build is missing' >&2
  exit 1
}
grep -Fq "$repo_root/packages/mcp/dist/index.js" "$profile" || {
  echo 'The tunnel profile is not running this fork' >&2
  exit 1
}

for local_node in "$HOME"/.local/share/claude-sessions-live/node-v24.15.0-linux-*/bin/node; do
  if [[ -x $local_node ]]; then
    export PATH="$(dirname "$local_node"):$PATH"
    break
  fi
done

# Build the updated server before restarting the existing tunnel.
cd "$repo_root"
corepack pnpm --filter claude-sessions-mcp build
corepack pnpm --filter claude-sessions-mcp test
corepack pnpm --filter claude-sessions-mcp typecheck

backup="${dropin}.before-dynamic.$(date -u +%Y%m%dT%H%M%SZ)"
cp -p "$dropin" "$backup"
restore=1
rollback() {
  status=$?
  if (( status != 0 && restore )); then
    echo 'Bridge update failed; restoring previous allowed sessions.' >&2
    cp -p "$backup" "$dropin"
    systemctl --user daemon-reload
    systemctl --user restart "$unit_name"
  fi
}
trap rollback EXIT

# Empty allowlists let calls select any transcript UUID and any tmux session.
# send_to_live_session still requires an active pane running Claude.
cat > "$dropin" <<'EOF'
[Service]
Environment=TMUX_MCP_ALLOWED_SESSIONS=
Environment=TMUX_MCP_ALLOWED_CLAUDE_SESSIONS=
EOF
systemctl --user daemon-reload
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
  echo 'Tunnel did not become ready after the update' >&2
  exit 1
fi

restore=0
trap - EXIT
echo 'Live bridge can now select an active Claude pane and transcript per call.'
echo "Previous allowlist backup: $backup"
