import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createMemory,
  currentMemoryName,
  deleteMemory,
  isValidMemoryName,
  listMemoryNames,
  memoryExists,
  switchMemory,
} from './workspace.js'
import { activeMemoryDir, localAgentDir, namedMemoryDir, resetActiveMemoryCache } from '../paths.js'
import { defaultSubconsciousStore, saveSubconsciousStore, loadSubconsciousStore } from '../subconscious/state.js'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'infiniti-memory-ws-test-'))
  resetActiveMemoryCache()
})

afterEach(async () => {
  resetActiveMemoryCache()
  await rm(cwd, { recursive: true, force: true })
})

describe('memory workspace CRUD', () => {
  it('starts with only main, which is current', async () => {
    expect(await listMemoryNames(cwd)).toEqual(['main'])
    expect(await currentMemoryName(cwd)).toBe('main')
    expect(await memoryExists(cwd, 'main')).toBe(true)
    expect(await memoryExists(cwd, 'nope')).toBe(false)
  })

  it('creates, switches, and deletes a named memory', async () => {
    await createMemory(cwd, 'work')
    expect(existsSync(namedMemoryDir(cwd, 'work'))).toBe(true)
    expect(await listMemoryNames(cwd)).toEqual(['main', 'work'])

    await switchMemory(cwd, 'work')
    expect(await currentMemoryName(cwd)).toBe('work')

    // 删除当前记忆应被拒绝
    await expect(deleteMemory(cwd, 'work')).rejects.toThrow()

    await switchMemory(cwd, 'main')
    await deleteMemory(cwd, 'work')
    expect(await listMemoryNames(cwd)).toEqual(['main'])
    expect(existsSync(namedMemoryDir(cwd, 'work'))).toBe(false)
  })

  it('protects main and validates names', async () => {
    await expect(createMemory(cwd, 'main')).rejects.toThrow()
    await expect(deleteMemory(cwd, 'main')).rejects.toThrow()
    await expect(createMemory(cwd, 'bad name')).rejects.toThrow()
    await expect(createMemory(cwd, '../escape')).rejects.toThrow()
    await createMemory(cwd, 'ok')
    await expect(createMemory(cwd, 'ok')).rejects.toThrow() // 重复
    await expect(switchMemory(cwd, 'ghost')).rejects.toThrow() // 不存在
  })

  it('isValidMemoryName guards path separators and length', () => {
    expect(isValidMemoryName('work')).toBe(true)
    expect(isValidMemoryName('work-2_a')).toBe(true)
    expect(isValidMemoryName('a/b')).toBe(false)
    expect(isValidMemoryName('-leading')).toBe(false)
    expect(isValidMemoryName('')).toBe(false)
    expect(isValidMemoryName('x'.repeat(65))).toBe(false)
  })

  it('self-heals when current points at a deleted memory', async () => {
    await mkdir(localAgentDir(cwd), { recursive: true })
    await writeFile(
      join(localAgentDir(cwd), 'memory-state.json'),
      JSON.stringify({ version: 1, current: 'gone', memories: [] }),
      'utf8',
    )
    expect(await currentMemoryName(cwd)).toBe('main')
  })
})

describe('memory workspace isolation', () => {
  it('routes store paths to the active memory dir and isolates content', async () => {
    // 用 metadata.lastHistoryScanTopic 当内容标记，区分两份记忆
    await saveSubconsciousStore(cwd, mkStore('main-state'))
    expect(activeMemoryDir(cwd)).toBe(localAgentDir(cwd))

    await createMemory(cwd, 'work')
    await switchMemory(cwd, 'work')
    expect(activeMemoryDir(cwd)).toBe(namedMemoryDir(cwd, 'work'))

    // work 的潜意识独立：尚未写入时拿到的是默认 store（无标记）
    expect((await loadSubconsciousStore(cwd)).metadata.lastHistoryScanTopic).toBeUndefined()
    await saveSubconsciousStore(cwd, mkStore('work-state'))
    expect((await loadSubconsciousStore(cwd)).metadata.lastHistoryScanTopic).toBe('work-state')

    // 切回 main，内容未被污染
    await switchMemory(cwd, 'main')
    expect((await loadSubconsciousStore(cwd)).metadata.lastHistoryScanTopic).toBe('main-state')
  })
})

function mkStore(tag: string): ReturnType<typeof defaultSubconsciousStore> {
  const base = defaultSubconsciousStore()
  return { ...base, metadata: { ...base.metadata, lastHistoryScanTopic: tag } }
}
