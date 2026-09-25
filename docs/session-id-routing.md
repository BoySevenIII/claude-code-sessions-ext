# Talk to a running Claude Code session by UUID

This fork lets an MCP client such as ChatGPT talk to an **existing interactive**
Claude Code session. It uses that session's current UUID to select the target,
delivers a message into Claude Code, and reads the reply from its transcript.
No tmux pane name from the caller, Claude startup flag, or second tunnel is
required. The original session-management tools remain available.

## How routing works

1. `list_active_claude_sessions` runs `claude agents --json` under the same
   Unix user as Claude Code. It reports interactive session UUIDs, PIDs, status,
   and working directories. The caller selects the current session UUID.
2. `send_to_claude_session({session_id, message})` looks up that UUID again.
   Only a session with status `idle` can receive input; a busy session or one
   waiting for a question or permission dialog is rejected.
3. The bridge follows the Claude process PID through `/proc` to its tmux pane,
   with Claude's session registry as a fallback. This is Claude Code's
   **internal** terminal delivery path. The user's own tmux session name is
   never part of the request.
4. Immediately before delivery it checks the UUID, PID, idle status, and pane
   again. The message is pasted literally and Enter is pressed. The tool
   reports `sent: true` when input is delivered; it does not wait for a reply.
5. `read_live_conversation({project_name, session_id})` reads recent user and
   assistant turns from that session's Claude Code JSONL transcript. Save its
   `next_offset` and pass it as `after_offset` on the next read to collect
   new turns while Claude works.

The bridge filters messages to a single line with a 16 KiB limit. Transcript
reading accepts a project folder name and UUID rather than an arbitrary path;
the initial read is bounded. Claude's transcript format is internal and can
change. A response may not appear until Claude has written its next turn.

A `/clear` command changes the session UUID; list sessions again before the
next send. The PID can remain stable even when the UUID changes, which is why
the bridge re-enumerates sessions rather than relying on a saved UUID-to-pane
mapping.

The earlier `list_live_panes` and `send_to_live_session` tools still offer
explicit pane targeting. They are optional; UUID routing does not require
the operator's tmux name. Claude channels are also unnecessary: they require
a flag at Claude startup and were not used for this approach.

## Installation on the Claude VM

The OpenAI Tunnel profile `CloudB-DEV-root` must launch **this fork's local
build** of `packages/mcp/dist/index.js`. A profile still running
`npx -y claude-sessions-mcp` starts the upstream package instead; building
this repository alone will not change the tools exposed to ChatGPT.

```bash
git -C ~/claude-code-sessions-ext pull --ff-only
bash ~/claude-code-sessions-ext/scripts/install-session-routing.sh
```

The installer builds, tests, and typechecks the MCP package. It accepts an
existing profile already pointing at this fork and also migrates the standard
`npx -y claude-sessions-mcp` command to the local Node 24 runtime and fork
entry point. It backs up the profile before modifying it and restores it if
the service fails its readiness check. It restarts the existing user service
`openai-tunnel-claude.service` and checks `/readyz`.

**Important:** a successful `/readyz` verifies that the tunnel is running,
not that ChatGPT discovered the new commands. Refresh the Claude CLI
connection's tools in ChatGPT and open a new chat. If the commands are absent,
check the profile's MCP command; this was the cause when a local build
contained all five bridge tools but the connector still exposed the old set.

## Use and verification

Ask the client to list active Claude sessions, select an idle interactive
session's current UUID, send a short message, and read the response. For
example, conceptually:

```text
list_active_claude_sessions()
send_to_claude_session({session_id: "<current-session-uuid>", message: "Hello, can you hear me?"})
read_live_conversation({project_name: "-home-claude-user-llamatar", session_id: "<current-session-uuid>"})
```

Continue reading with `after_offset` set to the previous `next_offset`.
Never interpret `sent: true` as Claude's answer. The transcript confirms
that Claude saw the input and shows its actual reply.

On 2026-09-25, the fork's MCP package built, its 26 tests passed, and its
TypeScript typecheck passed on the Claude VM. An end-to-end greeting was sent
to a live session by UUID and Claude replied: “Да, сообщение получил. 👍 На
связи, жду задачу.” This verifies the complete send-and-read path for that
installation; it does not guarantee that another host's process and tmux
layout will match.

The old user-scoped `chatgpt-channel` MCP entry may be removed from Claude
Code settings. A normal Claude startup works with this UUID routing.
