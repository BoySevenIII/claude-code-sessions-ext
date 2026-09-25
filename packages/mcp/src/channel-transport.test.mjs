import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { channelSocketPath, sendChannelMessage } from './channel-transport.ts'

const ID = '05930aa2-8088-4e85-bda6-60331be32be2'

test('rejects invalid identifiers and messages before contacting a session', async () => {
  assert.throws(() => sendChannelMessage('invalid', 'hello'), /Invalid Claude Session ID/)
  assert.throws(() => sendChannelMessage(ID, ''), /nonempty/)
  assert.throws(() => sendChannelMessage(ID, 'a'.repeat(16_385)), /16 KiB/)
})

test('send routes by Claude UUID over a local socket without tmux', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'channel-transport-'))
  const previous = process.env.CLAUDE_CHANNEL_SOCKET_DIR
  const previousAllowed = process.env.TMUX_MCP_ALLOWED_CLAUDE_SESSIONS
  process.env.CLAUDE_CHANNEL_SOCKET_DIR = dir
  delete process.env.TMUX_MCP_ALLOWED_CLAUDE_SESSIONS
  let received = ''
  const server = createServer(async (req, res) => {
    for await (const chunk of req) received += chunk.toString('utf8')
    res.writeHead(200).end('delivered')
  })
  try {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(channelSocketPath(ID), resolve)
      })
    } catch (error) {
      if (error.code === 'EPERM') { t.skip('Unix sockets unavailable in this sandbox'); return }
      throw error
    }
    assert.deepEqual(await sendChannelMessage(ID, 'Hello\nClaude'), { sent: true, session_id: ID })
    assert.equal(received, 'Hello\nClaude')
    assert.throws(() => sendChannelMessage('invalid', 'hello'), /Invalid Claude Session ID/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    if (previous === undefined) delete process.env.CLAUDE_CHANNEL_SOCKET_DIR
    else process.env.CLAUDE_CHANNEL_SOCKET_DIR = previous
    if (previousAllowed === undefined) delete process.env.TMUX_MCP_ALLOWED_CLAUDE_SESSIONS
    else process.env.TMUX_MCP_ALLOWED_CLAUDE_SESSIONS = previousAllowed
    await rm(dir, { recursive: true, force: true })
  }
})
