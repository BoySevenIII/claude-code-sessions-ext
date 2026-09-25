#!/usr/bin/env bash
# Replace the existing Claude Sessions MCP command in CloudB-DEV-root.
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 <current-claude-session-uuid> [tmux-session-name]" >&2
  exit 2
fi

claude_session_id=$1
tmux_session=${2:-masterplan2-109}
if [[ ! $claude_session_id =~ ^[a-f0-9]{8}-([a-f0-9]{4}-){3}[a-f0-9]{12}$ ]]; then
  echo 'Invalid Claude Session ID' >&2
  exit 2
fi
if [[ ! $tmux_session =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo 'Invalid tmux session name' >&2
  exit 2
fi

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
profile="$HOME/.config/tunnel-client/CloudB-DEV-root.yaml"
unit_name=openai-tunnel-claude.service
dropin_dir="$HOME/.config/systemd/user/${unit_name}.d"
dropin="$dropin_dir/90-live-bridge.conf"
backup="${profile}.before-live-bridge.$(date -u +%Y%m%dT%H%M%SZ)"
server="$repo_root/packages/mcp/dist/index.js"
changed=0

rollback() {
  status=$?
  if (( status != 0 && changed )); then
    set +e
    echo 'Installation failed; restoring the previous MCP command.' >&2
    cp -p "$backup" "$profile"
    rm -f "$dropin"
    systemctl --user daemon-reload
    systemctl --user restart "$unit_name"
  fi
}
trap rollback EXIT

for command in node corepack tmux python3 systemctl curl; do
  command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }
done
[[ -f $profile ]] || { echo 'Tunnel profile was not found' >&2; exit 1; }
[[ ! -e $dropin ]] || { echo "Drop-in already exists: $dropin" >&2; exit 1; }
[[ -f "$HOME/.claude/projects/-home-claude-user-llamatar/$claude_session_id.jsonl" ]] || {
  echo 'Claude transcript was not found under the llamatar project; check /status in the running session' >&2
  exit 1
}
systemctl --user cat "$unit_name" >/dev/null
tmux list-panes -s -t "$tmux_session" -F '#{pane_current_command} #{pane_dead}' |
  grep -qx 'claude 0' || { echo 'No live Claude pane in the selected tmux session' >&2; exit 1; }

echo 'Building and testing the fork before changing the tunnel...'
cd "$repo_root"
corepack pnpm --filter 'claude-sessions-mcp...' install --frozen-lockfile
corepack pnpm build:core
corepack pnpm build:mcp
corepack pnpm test:mcp
corepack pnpm --filter claude-sessions-mcp typecheck
[[ -f $server ]] || { echo 'MCP server build is missing' >&2; exit 1; }

cp -p "$profile" "$backup"
export LIVE_BRIDGE_PROFILE="$profile" LIVE_BRIDGE_SERVER="$server"
python3 - <<'PY'
import json
import os
from pathlib import Path

profile = Path(os.environ['LIVE_BRIDGE_PROFILE'])
text = profile.read_text()
old = 'command: "npx -y claude-sessions-mcp"'
if text.count(old) != 1:
    raise SystemExit('Expected exactly one original MCP command; profile left unchanged')
new = 'command: ' + json.dumps('node ' + os.environ['LIVE_BRIDGE_SERVER'])
temporary = profile.with_suffix(profile.suffix + '.tmp')
temporary.write_text(text.replace(old, new))
temporary.chmod(profile.stat().st_mode & 0o777)
temporary.replace(profile)
PY
changed=1
mkdir -p "$dropin_dir"
cat > "$dropin" <<EOF
[Service]
Environment=TMUX_MCP_ALLOWED_SESSIONS=$tmux_session
Environment=TMUX_MCP_ALLOWED_CLAUDE_SESSIONS=$claude_session_id
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
  echo 'Tunnel did not become ready; recent service log follows:' >&2
  journalctl --user -u "$unit_name" -n 20 --no-pager >&2
  exit 1
fi

changed=0
trap - EXIT
echo "Live bridge is ready. Previous profile backup: $backup"
echo 'Refresh the existing Claude CLI connection in ChatGPT to discover the three new tools.'
