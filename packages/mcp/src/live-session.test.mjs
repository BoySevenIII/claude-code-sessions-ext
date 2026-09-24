import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { listLivePanes, readLiveConversation, sendToLivePane } from './live-session.ts'

const ID = '6c4cce7f-5ea9-436d-99aa-744a8535df73'
const PROJECT = '-home-claude-user-llamatar'

test('a Claude session allowlist and byte cursor bound transcript reads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'live-claude-test-'))
  const previous = process.env.CLAUDE_SESSIONS_DIR
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
    if (previous === undefined) delete process.env.CLAUDE_SESSIONS_DIR
    else process.env.CLAUDE_SESSIONS_DIR = previous
    if (previousIds === undefined) delete process.env.TMUX_MCP_ALLOWED_CLAUDE_SESSIONS
    else process.env.TMUX_MCP_ALLOWED_CLAUDE_SESSIONS = previousIds
    await rm(dir, { recursive: true, force: true })
  }
})

test('live send refuses other sessions, dead panes, shells, and multiline input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'live-tmux-test-'))
  const previousPath = process.env.PATH
  const previousAllowed = process.env.TMUX_MCP_ALLOWED_SESSIONS
  try {
    const fake = join(dir, 'tmux')
    await writeFile(fake, '#!/bin/sh\ncase "$1" in list-panes) printf "masterplan2-109\\t%%109\\tbash\\t0\\tmain\\n";; esac\n', { mode: 0o755 })
    process.env.PATH = `${dir}:${previousPath}`
    process.env.TMUX_MCP_ALLOWED_SESSIONS = 'masterplan2-109'
    await assert.rejects(listLivePanes('other'), /allowlisted/)
    await assert.rejects(sendToLivePane('masterplan2-109', '%109', 'hello\nwhoami'), /one line/)
    await assert.rejects(sendToLivePane('masterplan2-109', '%109', 'hello'), /not an allowed Claude command/)
  } finally {
    process.env.PATH = previousPath
    if (previousAllowed === undefined) delete process.env.TMUX_MCP_ALLOWED_SESSIONS
    else process.env.TMUX_MCP_ALLOWED_SESSIONS = previousAllowed
    await rm(dir, { recursive: true, force: true })
  }
})

test('live send pastes literal text to an allowed Claude pane', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'live-tmux-send-'))
  const previousPath = process.env.PATH
  const previousAllowed = process.env.TMUX_MCP_ALLOWED_SESSIONS
  try {
    await writeFile(join(dir, 'tmux'), `#!/bin/sh
printf '%s\\n' "$1" >> '${dir}/calls'
case "$1" in
  list-panes) printf 'masterplan2-109\\t%%109\\tclaude\\t0\\tmain\\n' ;;
  load-buffer) cat > '${dir}/message' ;;
esac
`, { mode: 0o755 })
    process.env.PATH = `${dir}:${previousPath}`
    process.env.TMUX_MCP_ALLOWED_SESSIONS = 'masterplan2-109'
    const sent = await sendToLivePane('masterplan2-109', '%109', 'Hello; $(whoami)')
    assert.deepEqual(sent, { sent: true, pane_id: '%109' })
    assert.equal(await (await import('node:fs/promises')).readFile(join(dir, 'message'), 'utf8'), 'Hello; $(whoami)')
    const calls = await (await import('node:fs/promises')).readFile(join(dir, 'calls'), 'utf8')
    assert.match(calls, /list-panes\nload-buffer\npaste-buffer\nsend-keys\n/)
  } finally {
    process.env.PATH = previousPath
    if (previousAllowed === undefined) delete process.env.TMUX_MCP_ALLOWED_SESSIONS
    else process.env.TMUX_MCP_ALLOWED_SESSIONS = previousAllowed
    await rm(dir, { recursive: true, force: true })
  }
})
