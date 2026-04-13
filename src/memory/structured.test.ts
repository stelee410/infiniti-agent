import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  loadMemoryStore,
  executeMemoryAction,
  memoryToPromptBlock,
} from './structured.js'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'infiniti-mem-test-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

describe('loadMemoryStore', () => {
  it('returns empty store when no file exists', async () => {
    const store = await loadMemoryStore(cwd)
    expect(store.version).toBe(1)
    expect(store.entries).toEqual([])
  })
})

describe('executeMemoryAction — add', () => {
  it('adds a memory entry', async () => {
    const res = await executeMemoryAction(cwd, {
      action: 'add',
      title: '项目使用 TypeScript',
      body: '用户的项目基于 TypeScript 5.7',
      tag: 'fact',
    })
    expect(res.ok).toBe(true)
    expect(res.message).toContain('已添加')
    expect(res.usage).toContain('/')

    const store = await loadMemoryStore(cwd)
    expect(store.entries).toHaveLength(1)
    expect(store.entries[0]!.title).toBe('项目使用 TypeScript')
    expect(store.entries[0]!.tag).toBe('fact')
    expect(store.entries[0]!.id).toMatch(/^m_/)
  })

  it('rejects empty body', async () => {
    const res = await executeMemoryAction(cwd, {
      action: 'add',
      title: 'test',
      body: '  ',
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('body')
  })

  it('rejects when capacity exceeded', async () => {
    const bigBody = 'x'.repeat(5500)
    const res1 = await executeMemoryAction(cwd, {
      action: 'add',
      title: 'big',
      body: bigBody,
    })
    expect(res1.ok).toBe(true)

    const res2 = await executeMemoryAction(cwd, {
      action: 'add',
      title: 'overflow',
      body: 'x'.repeat(600),
    })
    expect(res2.ok).toBe(false)
    expect(res2.error).toContain('容量上限')
  })

  it('uses body prefix as title when title omitted', async () => {
    const res = await executeMemoryAction(cwd, {
      action: 'add',
      title: '',
      body: '这是一段很长的记忆内容，应该被截断为标题',
    })
    expect(res.ok).toBe(true)
    const store = await loadMemoryStore(cwd)
    expect(store.entries[0]!.title).toBe('这是一段很长的记忆内容，应该被截断为标题'.slice(0, 40))
  })
})

describe('executeMemoryAction — replace', () => {
  it('replaces an existing entry', async () => {
    await executeMemoryAction(cwd, {
      action: 'add',
      title: 'old title',
      body: 'old body',
      tag: 'fact',
    })
    const store = await loadMemoryStore(cwd)
    const id = store.entries[0]!.id

    const res = await executeMemoryAction(cwd, {
      action: 'replace',
      id,
      body: 'new body',
      tag: 'lesson',
    })
    expect(res.ok).toBe(true)

    const updated = await loadMemoryStore(cwd)
    expect(updated.entries[0]!.body).toBe('new body')
    expect(updated.entries[0]!.tag).toBe('lesson')
    expect(updated.entries[0]!.title).toBe('old title')
  })

  it('returns error for non-existent id', async () => {
    const res = await executeMemoryAction(cwd, {
      action: 'replace',
      id: 'nonexistent',
      body: 'x',
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('未找到')
  })
})

describe('executeMemoryAction — remove', () => {
  it('removes an entry by id', async () => {
    await executeMemoryAction(cwd, {
      action: 'add',
      title: 'to-delete',
      body: 'will be removed',
    })
    const store = await loadMemoryStore(cwd)
    const id = store.entries[0]!.id

    const res = await executeMemoryAction(cwd, { action: 'remove', id })
    expect(res.ok).toBe(true)

    const after = await loadMemoryStore(cwd)
    expect(after.entries).toHaveLength(0)
  })

  it('returns error for non-existent id', async () => {
    const res = await executeMemoryAction(cwd, {
      action: 'remove',
      id: 'nonexistent',
    })
    expect(res.ok).toBe(false)
  })
})

describe('executeMemoryAction — list', () => {
  it('lists all entries with usage', async () => {
    await executeMemoryAction(cwd, { action: 'add', title: 'a', body: 'body a' })
    await executeMemoryAction(cwd, { action: 'add', title: 'b', body: 'body b' })

    const res = await executeMemoryAction(cwd, { action: 'list' })
    expect(res.ok).toBe(true)
    expect(res.entries).toHaveLength(2)
    expect(res.usage).toContain('/')
  })

  it('lists empty store', async () => {
    const res = await executeMemoryAction(cwd, { action: 'list' })
    expect(res.ok).toBe(true)
    expect(res.entries).toHaveLength(0)
    expect(res.usage).toContain('0/')
  })
})

describe('memoryToPromptBlock', () => {
  it('returns empty string for empty store', () => {
    expect(memoryToPromptBlock({ version: 1, entries: [] })).toBe('')
  })

  it('formats entries with tags and ids', async () => {
    await executeMemoryAction(cwd, {
      action: 'add',
      title: 'TypeScript 项目',
      body: '使用 TS 5.7',
      tag: 'fact',
    })
    const store = await loadMemoryStore(cwd)
    const block = memoryToPromptBlock(store)
    expect(block).toContain('## 长期记忆')
    expect(block).toContain('[fact]')
    expect(block).toContain('TypeScript 项目')
    expect(block).toContain('使用 TS 5.7')
    expect(block).toMatch(/\d+%/)
  })
})
