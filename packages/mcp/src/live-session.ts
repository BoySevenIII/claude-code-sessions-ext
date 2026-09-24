/** Tools for speaking to one live Claude Code process and reading its transcript. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
const PANE = /^%[0-9]+$/
const PROJECT = /^[a-zA-Z0-9_-]+$/
const MAX_MESSAGE = 16_384
const MAX_READ = 2_000_000

const allowed = (name: string): Set<string> =>
  new Set((process.env[name] || '').split(',').map((s) => s.trim()).filter(Boolean))

function checkSession(sessionName: string): void {
  if (!allowed('TMUX_MCP_ALLOWED_SESSIONS').has(sessionName)) {
    throw new Error('tmux session is not allowlisted')
  }
}

export async function tmux(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('tmux', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    let error = ''
    let done = false
    const fail = (cause: Error) => {
      if (!done) {
        done = true
        reject(cause)
      }
    }
    const timer = setTimeout(() => {
      child.kill()
      fail(new Error('tmux timed out'))
    }, 10_000)
    child.stdout.setEncoding('utf8').on('data', (part: string) => {
      output += part
      if (output.length > 64_000) child.kill()
    })
    child.stderr.setEncoding('utf8').on('data', (part: string) => {
      error += part
      if (error.length > 4_000) child.kill()
    })
    child.on('error', (cause) => {
      clearTimeout(timer)
      fail(cause)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) fail(new Error(`tmux failed: ${error.slice(0, 500)}`))
      else if (!done) {
        done = true
        resolve(output)
      }
    })
    child.stdin.end(input)
  })
}

export interface LivePane {
  pane_id: string
  command: string
  dead: boolean
  window: string
}

export async function listLivePanes(sessionName: string): Promise<LivePane[]> {
  checkSession(sessionName)
  const rows = await tmux(['list-panes', '-s', '-t', sessionName, '-F',
    '#{session_name}\t#{pane_id}\t#{pane_current_command}\t#{pane_dead}\t#{window_name}'])
  return rows.split('\n').filter(Boolean).flatMap((line) => {
    const [name, pane_id, command, dead, window] = line.split('\t')
    return name === sessionName ? [{ pane_id, command, dead: dead === '1', window }] : []
  })
}

export async function sendToLivePane(sessionName: string, paneId: string, message: string): Promise<{ sent: true; pane_id: string }> {
  if (!PANE.test(paneId)) throw new Error('Invalid pane ID')
  if (!message.trim() || Buffer.byteLength(message, 'utf8') > MAX_MESSAGE || /[\r\n\0\x1b]/.test(message)) {
    throw new Error('Message must be one line, nonempty, under 16 KiB, without terminal control characters')
  }
  const pane = (await listLivePanes(sessionName)).find((candidate) => candidate.pane_id === paneId)
  if (!pane || pane.dead) throw new Error('Pane is missing or dead')
  const commands = allowed('TMUX_MCP_CLAUDE_COMMANDS')
  if (!commands.size) commands.add('claude')
  if (!commands.has(pane.command)) throw new Error(`Pane runs ${pane.command}, not an allowed Claude command`)
  const buffer = `claude_bridge_${randomUUID().replaceAll('-', '')}`
  await tmux(['load-buffer', '-b', buffer, '-'], message)
  try {
    await tmux(['paste-buffer', '-d', '-p', '-b', buffer, '-t', paneId])
    await tmux(['send-keys', '-t', paneId, 'Enter'])
  } finally {
    await tmux(['delete-buffer', '-b', buffer]).catch(() => undefined)
  }
  return { sent: true, pane_id: paneId }
}

export interface ConversationMessage {
  role: 'user' | 'assistant'
  uuid?: string
  timestamp?: string
  text: string
}

function readable(record: Record<string, unknown>): ConversationMessage | undefined {
  if ((record.type !== 'user' && record.type !== 'assistant') || record.isSidechain) return
  const message = record.message as { content?: unknown } | undefined
  const blocks = typeof message?.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : message?.content
  if (!Array.isArray(blocks)) return
  const text = blocks.flatMap((block: { type?: string; text?: string; name?: string }) => {
    if (block?.type === 'text') return [String(block.text || '')]
    if (block?.type === 'tool_use') return [`[tool: ${block.name || 'unknown'}]`]
    return []
  }).join('\n').trim()
  if (!text) return
  return { role: record.type, uuid: typeof record.uuid === 'string' ? record.uuid : undefined,
    timestamp: typeof record.timestamp === 'string' ? record.timestamp : undefined,
    text: text.slice(0, 8_000) }
}

export async function readLiveConversation(projectName: string, sessionId: string, afterOffset = 0, limit = 30) {
  if (!PROJECT.test(projectName) || !UUID.test(sessionId) || !allowed('TMUX_MCP_ALLOWED_CLAUDE_SESSIONS').has(sessionId)) {
    throw new Error('Claude session or project is not allowlisted')
  }
  if (!Number.isSafeInteger(afterOffset) || afterOffset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new Error('Invalid cursor or limit')
  }
  const sessionsDir = process.env.CLAUDE_SESSIONS_DIR || join(homedir(), '.claude', 'projects')
  const file = await open(join(sessionsDir, projectName, `${sessionId}.jsonl`), 'r')
  try {
    const size = (await file.stat()).size
    if (afterOffset > size) throw new Error('Transcript shrank; restart with after_offset=0')
    const start = afterOffset || Math.max(0, size - MAX_READ)
    const bytes = Math.min(MAX_READ, size - start)
    const data = Buffer.alloc(bytes)
    const { bytesRead } = await file.read(data, 0, bytes, start)
    const lastNewline = data.lastIndexOf(10, bytesRead - 1)
    if (lastNewline < 0) return { session_id: sessionId, messages: [], next_offset: start, truncated: start > 0 }
    const firstNewline = start && !afterOffset ? data.indexOf(10) + 1 : 0
    const lines = data.subarray(firstNewline, lastNewline + 1).toString('utf8').split('\n')
    const messages: ConversationMessage[] = []
    for (const line of lines) {
      if (!line) continue
      try {
        const item = readable(JSON.parse(line))
        if (item) messages.push(item)
      } catch { /* A malformed line does not block later messages. */ }
    }
    return { session_id: sessionId, messages: messages.slice(-limit), next_offset: start + lastNewline + 1,
      truncated: (start > 0 && !afterOffset) || messages.length > limit || start + lastNewline + 1 < size }
  } finally {
    await file.close()
  }
}
