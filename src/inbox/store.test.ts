import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { localInboxDir } from '../paths.js'
import { listInboxMessages, writeInboxMessage } from './store.js'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'infiniti-inbox-test-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

describe('writeInboxMessage', () => {
  it('writes json and markdown message files', async () => {
    const msg = await writeInboxMessage(cwd, {
      id: 'snap:ok',
      subject: '图片生成完成',
      body: '图片好了。',
      attachments: [{ kind: 'image', path: '/tmp/a.png', label: 'result' }],
      meta: { kind: 'snap' },
    })

    expect(msg.id).toBe('snap:ok')
    expect(msg.read).toBe(false)

    const json = await readFile(join(localInboxDir(cwd), 'snap-ok.json'), 'utf8')
    expect(json).toContain('"subject": "图片生成完成"')

    const md = await readFile(join(localInboxDir(cwd), 'snap-ok.md'), 'utf8')
    expect(md).toContain('# 图片生成完成')
    expect(md).toContain('![result](/tmp/a.png)')
  })
})

describe('listInboxMessages', () => {
  it('lists newest unread messages first', async () => {
    await writeInboxMessage(cwd, { id: 'old', subject: 'old', body: 'old' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await writeInboxMessage(cwd, { id: 'new', subject: 'new', body: 'new' })

    const msgs = await listInboxMessages(cwd, { unreadOnly: true })
    expect(msgs.map((m) => m.id)).toEqual(['new', 'old'])
  })

  it('returns empty list when inbox does not exist', async () => {
    expect(await listInboxMessages(cwd)).toEqual([])
  })
})
