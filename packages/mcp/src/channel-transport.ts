import { request } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/

export function channelSocketPath(sessionId: string): string {
  if (!UUID.test(sessionId)) throw new Error('Invalid Claude Session ID')
  const dir = process.env.CLAUDE_CHANNEL_SOCKET_DIR || join(homedir(), '.cache', 'claude-sessions-live', 'channels')
  return join(dir, `${sessionId}.sock`)
}

export function sendChannelMessage(sessionId: string, message: string): Promise<{ sent: true; session_id: string }> {
  const socketPath = channelSocketPath(sessionId)
  if (!message.trim() || Buffer.byteLength(message, 'utf8') > 16_384 || /\0/.test(message)) {
    throw new Error('Message must be nonempty, under 16 KiB, without NUL')
  }
  const allowed = (process.env.TMUX_MCP_ALLOWED_CLAUDE_SESSIONS || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (allowed.length && !allowed.includes(sessionId)) throw new Error('Claude session is not allowlisted')
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/message', method: 'POST', headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': Buffer.byteLength(message, 'utf8'),
    } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk.slice(0, 1000) })
      res.on('end', () => {
        if (res.statusCode === 200) resolve({ sent: true, session_id: sessionId })
        else reject(new Error(`Claude channel rejected the message: ${res.statusCode} ${body.slice(0, 200)}`))
      })
    })
    req.setTimeout(10_000, () => req.destroy(new Error('Claude channel timed out')))
    req.on('error', reject)
    req.end(message)
  })
}
