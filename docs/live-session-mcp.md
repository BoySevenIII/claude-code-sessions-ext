# Live Claude Code sessions over MCP

This optional MCP feature lets a client address a running **interactive**
Claude Code session by its current session UUID. It sends one line of input and
reads the resulting conversation from Claude Code's saved transcript.

## Requirements

- Linux with `/proc` and `tmux` visible to the MCP server.
- A recent Claude Code CLI providing `claude agents --json`.
- The MCP server runs as the same Unix user as the target Claude process and
  can reach its tmux server. It normally finds the CLI at `~/.local/bin/claude`;
  set `CLAUDE_BIN` to an absolute executable path otherwise.
- The caller is trusted to access the MCP server. Any caller allowed to use
  these tools can request sends to the Unix user's live sessions unless an
  allowlist is set. Treat MCP access as access to the local terminal and
  transcripts; do not expose it to an untrusted client.

The original project, session-management, Web UI, and extension features do
not depend on these requirements.

## Workflow

1. Call `list_active_claude_sessions` and select an interactive session's
   `session_id` with `status: "idle"`.
2. Call `read_live_conversation` with that UUID and its Claude project folder
   name (for example `-home-user-project`). Save the `next_offset`.
3. Call `send_to_claude_session({session_id, message})`. The message must be
   one nonempty line of at most 16 KiB without escape characters.
4. Poll `read_live_conversation` with `after_offset: next_offset` until the
   reply appears, carrying forward each new `next_offset`.

A send result means input reached the terminal. It is not Claude's reply.
Transcript writes may lag while a response streams. The initial read scans
at most the last 2 MB, returns at most 50 turns, and later reads use a byte
cursor. The JSONL transcript is a Claude Code implementation detail; its
format may require changes when Claude Code updates.

The UUID identifies the *current* conversation. `/clear` can rotate the
UUID while the process keeps its PID, so list sessions again after a clear.
There is no stored UUID-to-pane mapping.

## Routing and safeguards

`list_active_claude_sessions` invokes `claude agents --json` and returns the
session UUID, PID, status, and working directory for interactive sessions.
The send tool looks up the UUID again, requires the status to be `idle`,
follows the PID's parents through `/proc` to find Claude Code's tmux pane,
and uses Claude's session registry as a fallback. It rechecks UUID, PID,
status, and pane immediately before delivering literal text with tmux's
paste buffer and Enter. It refuses a busy session or one waiting on a dialog,
because terminal input there could answer the dialog.

`TMUX_MCP_ALLOWED_CLAUDE_SESSIONS`, when set to a comma-separated list of
UUIDs, restricts sending and transcript reading. It does not hide the
session list. If unset, any interactive session owned by the MCP server's
Unix user may be selected. The transcript tool accepts a project folder
name and UUID rather than an arbitrary filesystem path. To read transcripts
stored outside `~/.claude/projects`, set `CLAUDE_SESSIONS_DIR`.

The tmux pane is Claude Code's terminal delivery path. The caller does not
supply a tmux pane, the operator's tmux session name, or a Claude channels
startup flag. The bridge depends on the process layout and output of the
installed Claude CLI, so an update to Claude Code may require adaptation.
