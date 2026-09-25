import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { readLiveConversation } from './live-session.js'
import { listActiveClaudeSessions, sendToSessionId } from './session-target.js'

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
})

export function registerLiveTools(server: McpServer): void {
  server.tool('list_active_claude_sessions',
    'List running interactive Claude Code sessions with UUID, status, and project.', {},
    async () => result(await listActiveClaudeSessions()))

  server.tool('send_to_claude_session',
    'Deliver one line to an idle interactive Claude Code session by UUID. Returns delivery status, not the reply.', {
      session_id: z.string().describe('Current Claude Code session UUID from claude agents --json'),
      message: z.string().describe('One-line message for Claude Code'),
    }, async ({ session_id, message }) => result(await sendToSessionId(session_id, message)))

  server.tool('read_live_conversation',
    'Read recent user and assistant messages by Claude session ID. Pass next_offset as after_offset on the next call.', {
      project_name: z.string().describe('Claude project folder name, e.g. -home-user-project'),
      session_id: z.string().describe('Claude Code session UUID'),
      after_offset: z.number().int().nonnegative().default(0).describe('Byte cursor from previous next_offset; 0 reads a bounded tail'),
      limit: z.number().int().min(1).max(50).default(30).describe('Maximum user/assistant messages to return'),
    }, async ({ project_name, session_id, after_offset, limit }) =>
      result(await readLiveConversation(project_name, session_id, after_offset, limit)))
}
