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
`6c4cce7f-5ea9-436d-99aa-744a8535df73` is a **Claude Session ID**: it
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

## Installation on the Claude VM

Build the fork with the repository's `pnpm` workflow:

```bash
git clone https://github.com/BoySevenIII/claude-code-sessions-ext.git ~/claude-code-sessions-ext
cd ~/claude-code-sessions-ext
git switch feat/live-claude-tmux
corepack pnpm install --frozen-lockfile
corepack pnpm build:core
corepack pnpm build:mcp
corepack pnpm test:mcp
corepack pnpm --filter claude-sessions-mcp typecheck
```

Set the allowlists in the existing `openai-tunnel-claude.service` user unit
(or an environment file already read by that unit). The target process must
run as the same Unix user as the tunnel client:

```ini
Environment=TMUX_MCP_ALLOWED_SESSIONS=masterplan2-109
Environment=TMUX_MCP_ALLOWED_CLAUDE_SESSIONS=6c4cce7f-5ea9-436d-99aa-744a8535df73
```

In the existing `CloudB-DEV-root` tunnel profile, replace only the stdio MCP
command with the built fork:

```yaml
mcp:
  commands:
    - channel: main
      command: "node /home/claude_user/claude-code-sessions-ext/packages/mcp/dist/index.js"
```

Then validate and restart the existing tunnel:

```bash
tunnel-client doctor --profile CloudB-DEV-root --explain
systemctl --user daemon-reload
systemctl --user restart openai-tunnel-claude.service
systemctl --user status openai-tunnel-claude.service --no-pager
```

In the existing ChatGPT developer-mode connection, use **Refresh** to discover
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
