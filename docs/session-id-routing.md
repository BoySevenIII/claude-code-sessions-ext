# Address a running Claude Code session by UUID

`send_to_claude_session` accepts only a current Claude Session ID and a
one-line message. The caller does not need to know the user's tmux session
name, a pane ID, or a startup flag for Claude Code.

The bridge asks `claude agents --json` for the live interactive session's
`sessionId`, PID, and `status`. It accepts only an idle session, resolves the
PID to its pane using Claude Code's tmux process tree (or its session registry
as a fallback), checks the target again, and pastes the message literally.
This follows the discovery and input approach in
`BoySevenIII/gptagent/scripts/session_idle_cycle.py`. The underlying delivery
still uses Claude Code's internal tmux; it does not use the operator's tmux
session name or the launch-bound Claude channels feature.

Use `list_active_claude_sessions` to find the current UUID. `/clear` changes
the UUID, so select the new ID from this list before the next send. A session
waiting for a question or permission dialog is rejected; terminal input in
that state could answer the dialog.

To deploy after the base fork is already installed:

```bash
git -C ~/claude-code-sessions-ext pull --ff-only
bash ~/claude-code-sessions-ext/scripts/install-session-routing.sh
```

Refresh the Claude CLI app's tools in ChatGPT. Use
`send_to_claude_session({session_id, message})`, followed by
`read_live_conversation({project_name, session_id, after_offset})` to collect
Claude's new turns. Sending confirms input delivery, not a finished answer.

The earlier `chatgpt-channel` user-scoped MCP entry is no longer needed. It can
be removed from Claude Code's MCP settings, and Claude can be started normally
without `--dangerously-load-development-channels`.
