import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  loadProfileStore,
  executeProfileAction,
  profileToPromptBlock,
} from './userProfile.js'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'infiniti-profile-test-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

describe('loadProfileStore', () => {
  it('returns empty store when no file exists', async () => {
    const store = await loadProfileStore(cwd)
    expect(store.version).toBe(1)
    expect(store.entries).toEqual([])
  })
})

describe('executeProfileAction — add', () => {
  it('adds a profile entry', async () => {
    const res = await executeProfileAction(cwd, {
      action: 'add',
      title: '偏好 TypeScript',
      body: '用户偏好 TypeScript 而非 JavaScript',
      tag: 'tech_stack',
    })
    expect(res.ok).toBe(true)
    expect(res.message).toContain('已添加')

    const store = await loadProfileStore(cwd)
    expect(store.entries).toHaveLength(1)
    expect(store.entries[0]!.tag).toBe('tech_stack')
  })

  it('rejects empty body', async () => {
    const res = await executeProfileAction(cwd, {
      action: 'add',
      title: 'x',
      body: '',
    })
    expect(res.ok).toBe(false)
  })

  it('enforces capacity limit', async () => {
    await executeProfileAction(cwd, {
      action: 'add',
      title: 'big',
      body: 'y'.repeat(2800),
    })
    const res = await executeProfileAction(cwd, {
      action: 'add',
      title: 'overflow',
      body: 'y'.repeat(300),
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('容量上限')
  })
})

describe('executeProfileAction — replace', () => {
  it('replaces an existing entry', async () => {
    await executeProfileAction(cwd, {
      action: 'add',
      title: 'old',
      body: 'old body',
      tag: 'communication',
    })
    const store = await loadProfileStore(cwd)
    const id = store.entries[0]!.id

    const res = await executeProfileAction(cwd, {
      action: 'replace',
      id,
      body: 'new body',
    })
    expect(res.ok).toBe(true)

    const updated = await loadProfileStore(cwd)
    expect(updated.entries[0]!.body).toBe('new body')
    expect(updated.entries[0]!.title).toBe('old')
  })

  it('errors on non-existent id', async () => {
    const res = await executeProfileAction(cwd, {
      action: 'replace',
      id: 'ghost',
      body: 'x',
    })
    expect(res.ok).toBe(false)
  })
})

describe('executeProfileAction — remove', () => {
  it('removes an entry', async () => {
    await executeProfileAction(cwd, {
      action: 'add',
      title: 'del',
      body: 'to delete',
    })
    const store = await loadProfileStore(cwd)
    const id = store.entries[0]!.id

    const res = await executeProfileAction(cwd, { action: 'remove', id })
    expect(res.ok).toBe(true)
    const after = await loadProfileStore(cwd)
    expect(after.entries).toHaveLength(0)
  })
})

describe('executeProfileAction — list', () => {
  it('lists entries with usage', async () => {
    await executeProfileAction(cwd, { action: 'add', title: 'a', body: 'b' })
    const res = await executeProfileAction(cwd, { action: 'list' })
    expect(res.ok).toBe(true)
    expect(res.entries).toHaveLength(1)
    expect(res.usage).toContain('/')
  })
})

describe('profileToPromptBlock', () => {
  it('returns empty string for empty store', () => {
    expect(profileToPromptBlock({ version: 1, entries: [] })).toBe('')
  })

  it('formats entries correctly', async () => {
    await executeProfileAction(cwd, {
      action: 'add',
      title: '简洁回复',
      body: '用户偏好简洁回复',
      tag: 'communication',
    })
    const store = await loadProfileStore(cwd)
    const block = profileToPromptBlock(store)
    expect(block).toContain('## 用户画像')
    expect(block).toContain('[communication]')
    expect(block).toContain('简洁回复')
  })
})
