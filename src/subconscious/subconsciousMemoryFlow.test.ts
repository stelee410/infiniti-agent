import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { InfinitiConfig } from '../config/types.js'
import type { PersistedMessage } from '../llm/persisted.js'
import { localAgentDir } from '../paths.js'
import { buildSystemWithMemory } from '../prompt/systemBuilder.js'
import { loadSubconsciousStore } from './state.js'
import { SubconsciousAgent } from './agent.js'

vi.mock('../llm/oneShotCompletion.js', () => ({
  oneShotTextCompletion: vi.fn(async (opts: { system: string }) => {
    if (opts.system.includes('对话压缩助手')) {
      return '用户决定使用文档化长期记忆，并用 SQLite FTS 做本地检索。'
    }
    if (!opts.system.includes('记忆整理器')) {
      return '{}'
    }
    return JSON.stringify({
      memories: [
        {
          title: '文档化长期记忆',
          body: '用户希望长期记忆通过 Markdown 文档和 SQLite FTS 检索，而不是向量数据库。',
          tag: 'convention',
        },
      ],
      profile: [],
      knowledge: [
        {
          subject: '长期记忆',
          predicate: 'uses',
          object: 'Markdown documents with SQLite FTS',
        },
      ],
      fuzzy: [
        {
          text: '用户倾向于透明、可审计的记忆实现。',
          confidence: 0.55,
        },
      ],
      longTerm: [
        {
          text: 'The memory system should use document memory with SQLite FTS retrieval instead of vector databases.',
          confidence: 0.86,
        },
      ],
    })
  }),
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
  cwd = await mkdtemp(join(tmpdir(), 'infiniti-subconscious-flow-test-'))
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

const messages: PersistedMessage[] = [
  { role: 'user', content: '我想重新设计长期记忆。' },
  { role: 'assistant', content: '可以，我们先分析现有记忆系统。' },
  { role: 'user', content: '不要用向量数据库。' },
  { role: 'assistant', content: '明白，长期记忆应保持可审计。' },
  { role: 'user', content: '用 Markdown 文档和 SQLite FTS 搜索。' },
  { role: 'assistant', content: '我会把它整理成文档化长期记忆。' },
  { role: 'user', content: '还要完整闭环。' },
  { role: 'assistant', content: '闭环包括压缩、抽取、文档同步、检索和强化。' },
]

describe.runIf(sqliteAvailable)('subconscious memory compact flow', () => {
  it('compacts, extracts, syncs document memory, retrieves, and reinforces hits', async () => {
    const agent = new SubconsciousAgent(config, cwd)
    await agent.start()

    await agent.compactSessionAsync({
      messages,
      minTailMessages: 4,
      maxToolSnippetChars: 1000,
    })

    const docPath = join(localAgentDir(cwd), 'memory', 'long-term', 'long-term.md')
    const doc = await readFile(docPath, 'utf8')
    expect(doc).toContain('SQLite FTS')
    expect(doc).toContain('vector databases')

    const before = await loadSubconsciousStore(cwd)
    const entryBefore = before.memory.longTerm.find((entry) => entry.text.includes('SQLite FTS'))
    expect(entryBefore).toBeTruthy()

    const system = await buildSystemWithMemory(config, cwd, agent, 'How should SQLite FTS memory retrieval work?')
    expect(system).toContain('## 相关长期记忆')
    expect(system).toContain('document memory with SQLite FTS')

    await agent.waitForIdle()
    const after = await loadSubconsciousStore(cwd)
    const entryAfter = after.memory.longTerm.find((entry) => entry.id === entryBefore!.id)
    expect(entryAfter?.reinforcement).toBeGreaterThan(entryBefore!.reinforcement)
    expect(entryAfter?.confidence).toBeGreaterThan(entryBefore!.confidence)
  })
})
