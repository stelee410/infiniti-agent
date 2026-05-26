import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { InfinitiConfig } from '../config/types.js'
import { loadMemoryStore } from '../memory/structured.js'
import { loadProfileStore } from '../memory/userProfile.js'
import { loadSubconsciousStore } from './state.js'
import { SubconsciousAgent } from './agent.js'

// Mock LLM to avoid network. observeAssistantOutput enqueues refineWithLlm in background;
// we want it to be deterministic / fast.
vi.mock('../llm/oneShotCompletion.js', () => ({
  oneShotTextCompletion: vi.fn(async () => '{}'),
}))

let cwd: string
let sqliteAvailable = true

try {
  const Database = (await import('better-sqlite3')).default
  const db = new Database(':memory:')
  db.close()
} catch {
  sqliteAvailable = false
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'infiniti-agent-test-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

const config: InfinitiConfig = {
  version: 1,
  llm: {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-test',
    apiKey: 'sk-test',
  },
}

describe('SubconsciousAgent.observeUserInput', () => {
  it('appends a recent entry with source=user', async () => {
    const agent = new SubconsciousAgent(config, cwd)
    await agent.observeUserInput('你好')
    await agent.waitForIdle()
    const store = await loadSubconsciousStore(cwd)
    expect(store.recent).toHaveLength(1)
    expect(store.recent[0]!.source).toBe('user')
    expect(store.recent[0]!.text).toBe('你好')
    expect(typeof store.recent[0]!.at).toBe('string')
  })

  it('truncates long text to 500 chars', async () => {
    const agent = new SubconsciousAgent(config, cwd)
    const longText = 'x'.repeat(600)
    await agent.observeUserInput(longText)
    await agent.waitForIdle()
    const store = await loadSubconsciousStore(cwd)
    expect(store.recent[0]!.text).toHaveLength(500)
  })

  it('caps recent buffer at RECENT_LIMIT (20)', async () => {
    const agent = new SubconsciousAgent(config, cwd)
    for (let i = 0; i < 25; i++) {
      await agent.observeUserInput(`msg ${i}`)
    }
    await agent.waitForIdle()
    const store = await loadSubconsciousStore(cwd)
    expect(store.recent).toHaveLength(20)
    expect(store.recent[0]!.text).toBe('msg 5')
    expect(store.recent[19]!.text).toBe('msg 24')
  })

  it('records analysis object', async () => {
    const agent = new SubconsciousAgent(config, cwd)
    await agent.observeUserInput('你好')
    await agent.waitForIdle()
    const store = await loadSubconsciousStore(cwd)
    expect(store.recent[0]!.analysis).toBeDefined()
    expect(typeof store.recent[0]!.analysis).toBe('object')
  })
})

describe('SubconsciousAgent.observeAssistantOutput', () => {
  it('appends a recent entry with source=assistant', async () => {
    const agent = new SubconsciousAgent(config, cwd)
    await agent.observeAssistantOutput('好的，我来处理。')
    await agent.waitForIdle()
    const store = await loadSubconsciousStore(cwd)
    const assistantEntries = store.recent.filter((r) => r.source === 'assistant')
    expect(assistantEntries).toHaveLength(1)
    expect(assistantEntries[0]!.text).toBe('好的，我来处理。')
  })

  it('ignores empty/whitespace output', async () => {
    const agent = new SubconsciousAgent(config, cwd)
    await agent.observeAssistantOutput('   ')
    await agent.waitForIdle()
    const store = await loadSubconsciousStore(cwd)
    const assistantEntries = store.recent.filter((r) => r.source === 'assistant')
    expect(assistantEntries).toHaveLength(0)
  })

  it('truncates long text to 500 chars', async () => {
    const agent = new SubconsciousAgent(config, cwd)
    const longText = 'y'.repeat(700)
    await agent.observeAssistantOutput(longText)
    await agent.waitForIdle()
    const store = await loadSubconsciousStore(cwd)
    const assistantEntries = store.recent.filter((r) => r.source === 'assistant')
    expect(assistantEntries[0]!.text).toHaveLength(500)
  })
})

describe('SubconsciousAgent.executeMemoryAction', () => {
  it('add adds entry to memory store', async () => {
    const agent = new SubconsciousAgent(config, cwd)
    const res = await agent.executeMemoryAction({
      action: 'add',
      title: '项目用 TS',
      body: '本项目使用 TypeScript 5.7',
      tag: 'fact',
    })
    expect(res.ok).toBe(true)
    expect(res.message).toContain('已添加')
    const store = await loadMemoryStore(cwd)
    expect(store.entries).toHaveLength(1)
    expect(store.entries[0]!.title).toBe('项目用 TS')
    expect(store.entries[0]!.tag).toBe('fact')
  })

  it('list returns entries', async () => {
    const agent = new SubconsciousAgent(config, cwd)
    await agent.executeMemoryAction({ action: 'add', title: 'A', body: 'body A', tag: 'fact' })
    await agent.executeMemoryAction({ action: 'add', title: 'B', body: 'body B', tag: 'preference' })
    const res = await agent.executeMemoryAction({ action: 'list' })
    expect(res.ok).toBe(true)
    expect(res.entries).toHaveLength(2)
  })

  it('remove returns error when id missing', async () => {
    const agent = new SubconsciousAgent(config, cwd)
    const res = await agent.executeMemoryAction({ action: 'remove', id: 'nonexistent' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('未找到')
  })
})

describe('SubconsciousAgent.executeProfileAction', () => {
  it('add adds entry to profile store', async () => {
    const agent = new SubconsciousAgent(config, cwd)
    const res = await agent.executeProfileAction({
      action: 'add',
      title: '用户偏好简洁',
      body: '用户喜欢简洁直接的回复',
      tag: 'communication',
    })
    expect(res.ok).toBe(true)
    const store = await loadProfileStore(cwd)
    expect(store.entries).toHaveLength(1)
    expect(store.entries[0]!.title).toBe('用户偏好简洁')
  })
})

describe.runIf(sqliteAvailable)('SubconsciousAgent.executeKgAction', () => {
  it('add inserts triple', async () => {
    const agent = new SubconsciousAgent(config, cwd)
    const res = await agent.executeKgAction({
      action: 'add',
      subject: '用户',
      predicate: '喜欢',
      object: 'TypeScript',
    })
    expect(res.ok).toBe(true)
  })
})

describe.runIf(sqliteAvailable)('SubconsciousAgent.retrieveRelevantMemory', () => {
  it('returns empty string when no document memory', async () => {
    const agent = new SubconsciousAgent(config, cwd)
    await agent.start()
    const result = await agent.retrieveRelevantMemory('anything')
    expect(result).toBe('')
  })
})

describe('SubconsciousAgent.consolidateFromMessages', () => {
  it('appends user and assistant messages to recent buffer', async () => {
    const agent = new SubconsciousAgent(config, cwd)
    await agent.consolidateFromMessages([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ])
    await agent.waitForIdle()
    const store = await loadSubconsciousStore(cwd)
    const users = store.recent.filter((r) => r.source === 'user').map((r) => r.text)
    const assistants = store.recent.filter((r) => r.source === 'assistant').map((r) => r.text)
    expect(users).toEqual(['q1', 'q2'])
    expect(assistants).toEqual(['a1', 'a2'])
  })

  it('skips assistant messages with empty content', async () => {
    const agent = new SubconsciousAgent(config, cwd)
    await agent.consolidateFromMessages([
      { role: 'assistant', content: '   ' },
      { role: 'assistant', content: 'real' },
    ])
    await agent.waitForIdle()
    const store = await loadSubconsciousStore(cwd)
    const assistants = store.recent.filter((r) => r.source === 'assistant').map((r) => r.text)
    expect(assistants).toEqual(['real'])
  })

  it('no-op when messages list is empty', async () => {
    const agent = new SubconsciousAgent(config, cwd)
    await agent.consolidateFromMessages([])
    await agent.waitForIdle()
    const store = await loadSubconsciousStore(cwd)
    expect(store.recent).toHaveLength(0)
  })
})

describe('SubconsciousAgent.loadMemoryStore / loadProfileStore (wrappers)', () => {
  it('loadMemoryStore returns empty store when nothing saved', async () => {
    const agent = new SubconsciousAgent(config, cwd)
    const store = await agent.loadMemoryStore()
    expect(store.entries).toEqual([])
  })

  it('loadProfileStore returns empty store when nothing saved', async () => {
    const agent = new SubconsciousAgent(config, cwd)
    const store = await agent.loadProfileStore()
    expect(store.entries).toEqual([])
  })
})
