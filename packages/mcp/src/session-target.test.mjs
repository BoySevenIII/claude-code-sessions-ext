import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { sendToSessionId } from './session-target.ts'

const ID = '05930aa2-8088-4e85-bda6-60331be32be2'

test('UUID selects the live process pane; a waiting dialog blocks input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-target-'))
  const oldPath = process.env.PATH
  const oldBinary = process.env.CLAUDE_BIN
  const oldAllowed = process.env.TMUX_MCP_ALLOWED_SESSIONS
  const oldPid = process.env.BRIDGE_TEST_PID
  const oldStatus = process.env.BRIDGE_TEST_STATUS
  try {
    await writeFile(join(dir, 'claude'), `#!/bin/sh
printf '[{"sessionId":"${ID}","pid":%s,"kind":"interactive","status":"%s"}]\\n' "$BRIDGE_TEST_PID" "$BRIDGE_TEST_STATUS"
`, { mode: 0o755 })
    await writeFile(join(dir, 'tmux'), `#!/bin/sh
case "$1" in
  list-panes)
    case "$*" in
      *pane_pid*) printf '%s\\t%%205\\tinternal-claude\\tbash\\t0\\n' "$BRIDGE_TEST_PID" ;;
      *) printf '%%205\\t0\\n' ;;
    esac ;;
  load-buffer) cat > '${dir}/delivered' ;;
esac
`, { mode: 0o755 })
    process.env.PATH = `${dir}:${oldPath}`
    process.env.CLAUDE_BIN = join(dir, 'claude')
    process.env.TMUX_MCP_ALLOWED_SESSIONS = 'masterplan2-109'
    process.env.BRIDGE_TEST_PID = String(process.pid)
    process.env.BRIDGE_TEST_STATUS = 'waiting'
    await assert.rejects(sendToSessionId(ID, 'do not send'), /sending could answer a dialog/)
    process.env.BRIDGE_TEST_STATUS = 'idle'
    const sent = await sendToSessionId(ID, 'Hello Claude')
    assert.deepEqual(sent, { sent: true, session_id: ID, pid: process.pid })
    assert.equal(await readFile(join(dir, 'delivered'), 'utf8'), 'Hello Claude')
  } finally {
    process.env.PATH = oldPath
    for (const [key, old] of [['CLAUDE_BIN', oldBinary], ['TMUX_MCP_ALLOWED_SESSIONS', oldAllowed], ['BRIDGE_TEST_PID', oldPid], ['BRIDGE_TEST_STATUS', oldStatus]]) {
      if (old === undefined) delete process.env[key]
      else process.env[key] = old
    }
    await rm(dir, { recursive: true, force: true })
  }
})
