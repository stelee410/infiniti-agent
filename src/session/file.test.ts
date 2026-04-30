import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendSessionMessage, loadSession, saveSession } from './file.js'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'infiniti-session-file-test-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

describe('appendSessionMessage', () => {
  it('creates a missing session file', async () => {
    await appendSessionMessage(cwd, { role: 'assistant', content: 'created' })
    const session = await loadSession(cwd)
    expect(session?.messages).toHaveLength(1)
    expect(session?.messages[0]).toMatchObject({ role: 'assistant', content: 'created' })
  })

  it('preserves concurrent appends', async () => {
    await saveSession(cwd, [{ role: 'user', content: 'start' }])

    await Promise.all([
      appendSessionMessage(cwd, { role: 'assistant', content: 'one' }),
      appendSessionMessage(cwd, { role: 'assistant', content: 'two' }),
      appendSessionMessage(cwd, { role: 'assistant', content: 'three' }),
    ])

    const session = await loadSession(cwd)
    expect(session?.messages[0]).toMatchObject({ role: 'user', content: 'start' })
    const assistantText = session?.messages
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content)
      .sort()
    expect(assistantText).toEqual(['one', 'three', 'two'])
  })
})
