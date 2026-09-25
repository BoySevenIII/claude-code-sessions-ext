#!/usr/bin/env node
// Claude Code starts this MCP channel as a child of the live interactive session.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer, request } from 'node:http'
import { chmod, mkdir, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { channelSocketPath } from './channel-transport.js'

const sessionId = process.env.CLAUDE_CODE_SESSION_ID
if (!sessionId) throw new Error('Claude Code did not provide CLAUDE_CODE_SESSION_ID')
const socketPath = channelSocketPath(sessionId)

const mcp = new Server({ name: 'chatgpt-channel', version: '0.1.0' }, {
  capabilities: { experimental: { 'claude/channel': {} } },
  instructions: 'Messages from ChatGPT arrive as <channel source="chatgpt"> events. Respond normally in this session; the bridge reads your transcript.',
})

const http = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/message') {
    res.writeHead(404).end()
    return
  }
  let message = ''
  try {
    for await (const part of req) {
      message += part.toString('utf8')
      if (Buffer.byteLength(message, 'utf8') > 16_384) {
        res.writeHead(413).end()
        return
      }
    }
    if (!message.trim()) { res.writeHead(400).end(); return }
    await mcp.notification({ method: 'notifications/claude/channel', params: {
      content: message, meta: { source: 'chatgpt' },
    } })
    res.writeHead(200).end('delivered')
  } catch (error) {
    console.error(error)
    res.writeHead(503).end('channel unavailable')
  }
})

await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })
// Remove a crashed channel's leftover socket only if nobody is listening on it.
try {
  await new Promise<void>((resolve, reject) => {
    const probe = request({ socketPath, path: '/', method: 'GET' }, (res) => {
      res.resume()
      reject(new Error(`Claude session ${sessionId} already has a running channel`))
    })
    probe.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') resolve()
      else reject(error)
    })
    probe.setTimeout(1000, () => probe.destroy(new Error('Channel socket probe timed out')))
    probe.end()
  })
  await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
  await mcp.connect(new StdioServerTransport())
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(socketPath, resolve)
  })
  await chmod(socketPath, 0o600)
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
