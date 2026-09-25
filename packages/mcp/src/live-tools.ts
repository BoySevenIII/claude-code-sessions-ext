import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { listLivePanes, readLiveConversation, sendToLivePane } from './live-session.js'
import { listActiveClaudeSessions, sendToSessionId } from './session-target.js'

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
})

export function registerLiveTools(server: McpServer): void {
  server.tool('list_active_claude_sessions',
    'List running interactive Claude Code sessions with UUID, status, and project; no tmux pane identifier is needed.', {},
    async () => result(await listActiveClaudeSessions()))

  server.tool('send_to_claude_session',
    'Send one line to an idle interactive Claude Code session by UUID. The bridge discovers its process and internal tmux pane. Returns delivery status, not Claude response.', {
      session_id: z.string().describe('Current Claude Code session UUID from claude agents --json'),
      message: z.string().describe('One-line message for Claude Code'),
    }, async ({ session_id, message }) => result(await sendToSessionId(session_id, message)))

  server.tool('list_live_panes', 'List panes in an explicitly allowed tmux session', {
    session_name: z.string().describe('tmux session name, e.g. masterplan2-109'),
  }, async ({ session_name }) => result(await listLivePanes(session_name)))

  server.tool('send_to_live_session',
    'Send one line of text and Enter to a running Claude Code pane. Returns delivery status, not the Claude response.', {
      session_name: z.string().describe('tmux session name'),
      pane_id: z.string().describe('Stable pane ID, e.g. %109'),
      message: z.string().describe('Single-line message for Claude'),
    }, async ({ session_name, pane_id, message }) =>
      result(await sendToLivePane(session_name, pane_id, message)))

  server.tool('read_live_conversation',
    'Read recent user and assistant messages by Claude session ID. Pass next_offset as after_offset on the next call.', {
      project_name: z.string().describe('Claude project folder name, e.g. -home-claude-user-llamatar'),
      session_id: z.string().describe('Claude Code session UUID, not the tmux session name'),
      after_offset: z.number().int().nonnegative().default(0).describe('Byte cursor from previous next_offset; 0 reads a bounded tail'),
      limit: z.number().int().min(1).max(50).default(30).describe('Maximum user/assistant messages to return'),
    }, async ({ project_name, session_id, after_offset, limit }) =>
      result(await readLiveConversation(project_name, session_id, after_offset, limit)))
}
