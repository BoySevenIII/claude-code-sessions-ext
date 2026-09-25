# Send to a running Claude Code session without tmux

Claude Code's [channels API](https://code.claude.com/docs/en/channels-reference)
lets an MCP server push an event into an already-running session. This fork
adds `send_to_claude_session`, which selects that session by its Claude UUID.
The bridge sends to a local Unix socket owned by the channel process that
Claude Code started. No terminal input or tmux pane ID is involved.

`claude --resume <id> -p` starts a separate CLI process. The channel instead
delivers to the currently running process, with its working context. The
existing `read_live_conversation` tool still reads the JSONL transcript by
UUID and byte cursor; a successful send confirms delivery, not a finished
Claude response.

## Install on the Claude VM

The existing ChatGPT tunnel must already be running this fork:

```bash
git -C ~/claude-code-sessions-ext pull --ff-only
bash ~/claude-code-sessions-ext/scripts/install-claude-channel.sh
```

The script builds/tests the fork, registers a user-scoped stdio MCP server
named `chatgpt-channel` in Claude Code, then restarts the existing ChatGPT
tunnel. It does not stop your interactive Claude Code process. To activate
the channel, exit that process and resume the same UUID in its project:

```bash
cd ~/llamatar
claude --resume 05930aa2-8088-4e85-bda6-60331be32be2 \
  --dangerously-load-development-channels server:chatgpt-channel
```

Custom channels are in research preview. Claude Code asks you to confirm
loading this development channel. If the channel is blocked by organization
policy, an organization owner must enable channels. The `--resume` argument
uses an explicit UUID so the channel subprocess receives that same ID in
`CLAUDE_CODE_SESSION_ID`; after `/clear` or changing sessions, restart the
channel for the new session ID.

Refresh the **Claude CLI** app's tools in ChatGPT, then in a new chat:

1. Call `send_to_claude_session` with the Claude UUID and your message.
2. Call `read_live_conversation` with project name
   `-home-claude-user-llamatar`, the same UUID, and `after_offset=0`.
3. Poll with the returned `next_offset` to see further replies.

The Unix socket lives under `~/.cache/claude-sessions-live/channels` (or
`CLAUDE_CHANNEL_SOCKET_DIR`) and is scoped to the Unix user. Only the Claude
process that spawned a channel for a UUID listens on that UUID's socket.
Messages are limited to 16 KiB. Optional
`TMUX_MCP_ALLOWED_CLAUDE_SESSIONS` can restrict allowed UUIDs even when the
tmux tools are unused.
