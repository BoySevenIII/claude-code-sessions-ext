# Live Claude Code bridge

## Why this exists

The original `claude-sessions-mcp` manages saved Claude Code sessions. It can
find and analyze a transcript, but it cannot send a message to a Claude Code
process that is currently running in a terminal. This extension adds that
missing path so another MCP client, such as ChatGPT, can collaborate with a
specific live Claude session.

The existing session tools remain available through the same MCP server and
the same OpenAI Tunnel. There is no second tunnel or connector to maintain.

## What was added

| MCP tool | Purpose |
| --- | --- |
| `list_live_panes` | Locate a pane in an explicitly allowed tmux session and inspect its running command. |
| `send_to_live_session` | Paste one message into a Claude Code pane and press Enter. The result confirms tmux delivery, not a completed Claude response. |
| `read_live_conversation` | Read a bounded tail of the Claude transcript by **Claude Session ID**. Subsequent calls use a byte cursor to return only new messages. |

There are two different identifiers. `masterplan2-109` is a **tmux session
name**: it identifies the terminal that receives input. A UUID such as
`<current-claude-session-id>` is a **Claude Session ID** (a UUID from `/status`): it
identifies the conversation transcript. They are configured separately.

## Intended workflow

1. Find the pane with `list_live_panes`. Confirm that its command is `claude`.
2. Call `read_live_conversation` with the Claude project folder name and
   Session ID. Save its `next_offset`.
3. Call `send_to_live_session` with the tmux session name, pane ID, and a short
   message.
4. Call `read_live_conversation` with `after_offset = next_offset` to collect
   new user and assistant messages. Repeat with the returned cursor while
   Claude is working.

This keeps terminal rendering out of the normal reading path. The JSONL
transcript is Claude Code's internal format and may change after an update;
the parser will then need to be adjusted. Transcript writes can also lag a
response that is still streaming.

## Replace the existing MCP on the Claude VM

The installer builds and tests the fork before changing the running
`CloudB-DEV-root` profile. It backs up the profile and restores it automatically
if the tunnel fails its readiness check. Use the **current** Claude Session ID
shown by `/status` in the target interactive session:

If the host has Node 20, the installer downloads Node 24.15.0 into
`~/.local/share/claude-sessions-live`, verifies the official SHA-256 checksum,
and uses that executable for the build and the MCP service. System Node is
unchanged. The host needs access to `nodejs.org` for the first download.

```bash
git clone https://github.com/BoySevenIII/claude-code-sessions-ext.git ~/claude-code-sessions-ext
cd ~/claude-code-sessions-ext
git switch feat/live-claude-tmux
bash scripts/install-live-bridge.sh '<current-claude-session-id>' masterplan2-109
```

The target process must run as the same Unix user as the tunnel client. The
installer creates a user-unit drop-in with the two allowlists:

```ini
Environment=TMUX_MCP_ALLOWED_SESSIONS=masterplan2-109
Environment=TMUX_MCP_ALLOWED_CLAUDE_SESSIONS=<current-claude-session-id>
```

It changes only the stdio MCP command in the existing `CloudB-DEV-root` profile:

```yaml
mcp:
  commands:
    - channel: main
      command: "/home/claude_user/.local/share/claude-sessions-live/node-v24.15.0-linux-x64/bin/node /home/claude_user/claude-code-sessions-ext/packages/mcp/dist/index.js"
```

The script restarts the existing service and verifies `/readyz`. In the
existing ChatGPT developer-mode connection, use **Refresh** to discover
the three new tools. If the fork fails to start, restore the original
`npx -y claude-sessions-mcp` command and restart the same service. Keep the
control-plane key in its existing local environment file; never put it in Git.

## Access boundaries

Both the tmux session and Claude Session ID require explicit environment
allowlists. Sending rejects dead panes, shells, unrecognized pane IDs, terminal
escape characters, multiline input, and messages over 16 KiB. The tmux process
name defaults to `claude`; set `TMUX_MCP_CLAUDE_COMMANDS` only if the
actual Claude process uses another name. Never allowlist a shell such as
`bash` or `zsh`: a process might exit between the pane check and the paste.

The transcript tool accepts a project folder name and Session ID, never an
arbitrary filesystem path. Its first read scans at most the last 2 MB and
returns at most 50 messages; later reads begin at the supplied byte cursor.
When Claude switches conversations or `/clear` creates a new ID, update the
Claude Session ID allowlist.

On Node 24, the focused tests can also run without installing the workspace:
`node --experimental-strip-types --test packages/mcp/src/live-session.test.mjs`.
On the Claude VM's Node 20 runtime, use the repository's `corepack pnpm test:mcp`
after installing dependencies.
