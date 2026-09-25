import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pasteToPane, tmux } from './live-session.js'

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/

interface Agent { sessionId?: string; pid?: number; kind?: string; status?: string; waitingFor?: string; cwd?: string; name?: string }

function agentsJson(): Promise<Agent[]> {
  return new Promise((resolve, reject) => {
    const binary = process.env.CLAUDE_BIN || join(homedir(), '.local', 'bin', 'claude')
    const child = spawn(binary, ['agents', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let error = ''
    let done = false
    const finish = (cause?: Error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (cause) reject(cause)
      else {
        try {
          const parsed: unknown = JSON.parse(output)
          if (!Array.isArray(parsed)) throw new Error('claude agents --json did not return an array')
          resolve(parsed as Agent[])
        } catch (e) { reject(e) }
      }
    }
    const timer = setTimeout(() => { child.kill(); finish(new Error('claude agents --json timed out')) }, 20_000)
    child.stdout.setEncoding('utf8').on('data', (part: string) => {
      output += part
      if (output.length > 1_000_000) { child.kill(); finish(new Error('Claude agent list is too large')) }
    })
    child.stderr.setEncoding('utf8').on('data', (part: string) => { error += part.slice(0, 1000) })
    child.on('error', (cause) => finish(cause))
    child.on('close', (code) => finish(code === 0 ? undefined : new Error(`claude agents --json failed: ${error.slice(0, 200)}`)))
  })
}

async function ancestorPids(pid: number): Promise<Set<number>> {
  const chain = new Set<number>()
  for (let current = pid, depth = 0; current > 1 && depth < 64 && !chain.has(current); depth++) {
    chain.add(current)
    try {
      const stat = await readFile(`/proc/${current}/stat`, 'utf8')
      current = Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[1])
    } catch { break }
  }
  return chain
}

export async function listActiveClaudeSessions() {
  return (await agentsJson()).filter((a) => a.kind === 'interactive' && UUID.test(a.sessionId || '') && Number.isSafeInteger(a.pid) && a.pid! > 1)
    .map((a) => ({ session_id: a.sessionId!, pid: a.pid!, status: a.status, waiting_for: a.waitingFor, name: a.name, cwd: a.cwd }))
}

export async function sendToSessionId(sessionId: string, message: string) {
  if (!UUID.test(sessionId)) throw new Error('Invalid Claude Session ID')
  const allowed = new Set((process.env.TMUX_MCP_ALLOWED_CLAUDE_SESSIONS || '').split(',').map((id) => id.trim()).filter(Boolean))
  if (allowed.size && !allowed.has(sessionId)) throw new Error('Claude session is not allowlisted')
  const agents = await listActiveClaudeSessions()
  const agent = agents.find((item) => item.session_id === sessionId)
  if (!agent) throw new Error('Claude session is not active; refresh the session list after /clear')
  if (agent.status !== 'idle') throw new Error(`Claude is ${agent.status || 'in an unknown state'}; sending could answer a dialog or interrupt work`)
  const chain = await ancestorPids(agent.pid)
  if (!chain.has(agent.pid)) throw new Error('Claude process has exited')
  const rows = await tmux(['list-panes', '-a', '-F', '#{pane_pid}\t#{pane_id}\t#{session_name}\t#{pane_current_command}\t#{pane_dead}'])
  const panes = rows.split('\n').filter(Boolean).map((line) => {
    const [panePid, paneId, name, command, dead] = line.split('\t')
    return { panePid: Number(panePid), paneId, name, command, dead }
  })
  let pane = panes.find((item) => chain.has(item.panePid) && item.dead === '0')
  if (!pane) {
    // Claude's own registry is a fallback for tmux layouts with an unusual process tree.
    try {
      const registry = JSON.parse(await readFile(join(homedir(), '.claude', 'sessions', `${agent.pid}.json`), 'utf8'))
      const id = String(registry.tmux || '').match(/%[0-9]+$/)?.[0]
      pane = panes.find((item) => item.paneId === id && item.dead === '0')
    } catch { /* No native registry entry */ }
  }
  if (!pane) throw new Error('Active Claude process has no matching tmux pane')
  // Re-check the agent and pane before paste; the caller never supplies a pane.
  const current = (await listActiveClaudeSessions()).find((item) => item.session_id === sessionId)
  if (!current || current.pid !== agent.pid || current.status !== 'idle') {
    throw new Error('Claude session changed state while resolving its pane')
  }
  const liveRows = await tmux(['list-panes', '-a', '-F', '#{pane_id}\t#{pane_dead}'])
  if (!liveRows.split('\n').includes(`${pane.paneId}\t0`)) throw new Error('Claude pane disappeared before delivery')
  await pasteToPane(pane.paneId, message)
  return { sent: true as const, session_id: sessionId, pid: agent.pid }
}
