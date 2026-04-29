import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { documentMemoryDir, documentMemoryHitsToPromptBlock, retrieveDocumentMemories, syncDocumentMemory } from './documentMemory.js'
import type { SubconsciousStore } from '../subconscious/types.js'

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
  cwd = await mkdtemp(join(tmpdir(), 'infiniti-docmem-test-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

function store(): SubconsciousStore {
  const now = new Date().toISOString()
  return {
    version: 1,
    metadata: {},
    state: {
      emotion: 'neutral',
      emotionIntensity: 0.2,
      mood: 0,
      affinity: 0,
      trust: 0,
      intimacy: 0,
      respect: 0,
      tension: 0,
      confidence: 0.6,
      engagement: 0.5,
      speechStyle: 'natural',
      updatedAt: now,
    },
    memory: {
      project: [],
      userPreference: [],
      persona: [],
      fuzzy: [],
      longTerm: [
        {
          id: 'lt_memory_docs',
          text: '用户希望长期记忆使用 Markdown 文档和 SQLite FTS 搜索，而不是向量数据库。',
          confidence: 0.88,
          reinforcement: 4,
          sources: [{ type: 'compact', ref: 'test', at: now }],
          firstSeenAt: now,
          lastSeenAt: now,
          validFrom: now,
          topic: '长期记忆',
        },
      ],
    },
    recent: [],
  }
}

describe.runIf(sqliteAvailable)('document memory FTS', () => {
  it('syncs markdown documents and retrieves by indexed topic/body', async () => {
    await syncDocumentMemory(cwd, store())

    const hits = await retrieveDocumentMemories(cwd, 'SQLite FTS 长期记忆', 3)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.id).toBe('lt_memory_docs')
    expect(hits[0]!.text).toContain('Markdown 文档')

    const block = documentMemoryHitsToPromptBlock(hits)
    expect(block).toContain('## 相关长期记忆')
    expect(block).toContain('SQLite FTS')
  })

  it('falls back to document scanning when the FTS db is absent', async () => {
    await syncDocumentMemory(cwd, store())
    await rm(join(documentMemoryDir(cwd), 'index.db'), { force: true })

    const hits = await retrieveDocumentMemories(cwd, 'Markdown 文档', 3)
    expect(hits.some((hit) => hit.id === 'lt_memory_docs')).toBe(true)
  })
})
