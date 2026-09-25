import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pasteToPane, readLiveConversation } from './live-session.ts'

const ID = '12345678-1234-4123-8123-123456789abc'
const PROJECT = '-home-user-project'

test('transcript reads are bounded by UUID, allowlist, and byte cursor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'live-conversation-'))
  const previousDir = process.env.CLAUDE_SESSIONS_DIR
  const previousIds = process.env.TMUX_MCP_ALLOWED_CLAUDE_SESSIONS
  try {
    process.env.CLAUDE_SESSIONS_DIR = dir
    process.env.TMUX_MCP_ALLOWED_CLAUDE_SESSIONS = ID
    await mkdir(join(dir, PROJECT))
    const file = join(dir, PROJECT, `${ID}.jsonl`)
    await writeFile(file, JSON.stringify({ type: 'assistant', uuid: 'a', message: { content: [{ type: 'text', text: 'First' }] } }) + '\n')
    const first = await readLiveConversation(PROJECT, ID)
    assert.deepEqual(first.messages.map((m) => m.text), ['First'])
    await appendFile(file, JSON.stringify({ type: 'user', uuid: 'b', message: { content: 'Second' } }) + '\n')
    const second = await readLiveConversation(PROJECT, ID, first.next_offset)
    assert.deepEqual(second.messages.map((m) => m.text), ['Second'])
    await assert.rejects(readLiveConversation(PROJECT, '00000000-0000-0000-0000-000000000000'), /allowlisted/)
  } finally {
    if (previousDir === undefined) delete process.env.CLAUDE_SESSIONS_DIR
    else process.env.CLAUDE_SESSIONS_DIR = previousDir
    if (previousIds === undefined) delete process.env.TMUX_MCP_ALLOWED_CLAUDE_SESSIONS
    else process.env.TMUX_MCP_ALLOWED_CLAUDE_SESSIONS = previousIds
    await rm(dir, { recursive: true, force: true })
  }
})

test('paste sends literal input and rejects multiline messages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'live-input-'))
  const previousPath = process.env.PATH
  try {
    await writeFile(join(dir, 'tmux'), `#!/bin/sh
printf '%s\\n' "$1" >> '${dir}/calls'
case "$1" in
  load-buffer) cat > '${dir}/message' ;;
esac
`, { mode: 0o755 })
    process.env.PATH = `${dir}:${previousPath}`
    await assert.rejects(pasteToPane('%205', 'hello\nunsafe'), /one line/)
    await pasteToPane('%205', 'Hello; $(whoami)')
    assert.equal(await readFile(join(dir, 'message'), 'utf8'), 'Hello; $(whoami)')
    assert.match(await readFile(join(dir, 'calls'), 'utf8'), /load-buffer\npaste-buffer\nsend-keys\n/)
  } finally {
    process.env.PATH = previousPath
    await rm(dir, { recursive: true, force: true })
  }
})
