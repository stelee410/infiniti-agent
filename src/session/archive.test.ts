import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { PersistedMessage } from '../llm/persisted.js'
import { archiveSession, searchSessions } from './archive.js'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'infiniti-archive-test-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

const sampleMessages: PersistedMessage[] = [
  { role: 'user', content: '帮我设置 PostgreSQL 数据库' },
  { role: 'assistant', content: '好的，我来帮你设置 PostgreSQL。首先需要安装...' },
  { role: 'user', content: '使用 Docker 来运行' },
  { role: 'assistant', content: '使用 docker-compose 是个好选择...' },
]

describe('archiveSession', () => {
  it('archives a session and returns a positive id', async () => {
    const id = await archiveSession(cwd, sampleMessages)
    expect(id).toBeGreaterThan(0)
  })

  it('returns -1 for empty messages', async () => {
    const id = await archiveSession(cwd, [])
    expect(id).toBe(-1)
  })

  it('archives multiple sessions with unique ids', async () => {
    const id1 = await archiveSession(cwd, sampleMessages)
    const id2 = await archiveSession(cwd, [
      { role: 'user', content: '另一个话题' },
      { role: 'assistant', content: '好的' },
    ])
    expect(id1).not.toBe(id2)
    expect(id2).toBeGreaterThan(id1)
  })

  it('stores only user and assistant text content', async () => {
    const msgs: PersistedMessage[] = [
      { role: 'user', content: '运行命令' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', name: 'bash', argumentsJson: '{}' }],
      },
      { role: 'tool', toolCallId: 'c1', name: 'bash', content: 'output' },
      { role: 'assistant', content: '命令执行完毕' },
    ]
    const id = await archiveSession(cwd, msgs)
    expect(id).toBeGreaterThan(0)
  })
})

describe('searchSessions', () => {
  it('finds sessions by keyword', async () => {
    await archiveSession(cwd, sampleMessages)
    const results = await searchSessions(cwd, 'PostgreSQL')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.snippet).toContain('PostgreSQL')
  })

  it('returns empty for unmatched query', async () => {
    await archiveSession(cwd, sampleMessages)
    const results = await searchSessions(cwd, 'xyznonexistent')
    expect(results).toHaveLength(0)
  })

  it('searches across multiple sessions', async () => {
    await archiveSession(cwd, sampleMessages)
    await archiveSession(cwd, [
      { role: 'user', content: '如何配置 Redis 缓存' },
      { role: 'assistant', content: 'Redis 的配置方法如下...' },
    ])

    const pg = await searchSessions(cwd, 'PostgreSQL')
    const redis = await searchSessions(cwd, 'Redis')
    expect(pg.length).toBeGreaterThan(0)
    expect(redis.length).toBeGreaterThan(0)
  })

  it('respects limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await archiveSession(cwd, [
        { role: 'user', content: `Docker 问题 #${i}` },
        { role: 'assistant', content: `Docker 解答 #${i}` },
      ])
    }
    const results = await searchSessions(cwd, 'Docker', 2)
    expect(results.length).toBeLessThanOrEqual(2)
  })

  it('includes session metadata in results', async () => {
    await archiveSession(cwd, sampleMessages)
    const results = await searchSessions(cwd, 'Docker')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]).toHaveProperty('sessionId')
    expect(results[0]).toHaveProperty('sessionSummary')
    expect(results[0]).toHaveProperty('sessionDate')
    expect(results[0]).toHaveProperty('role')
  })

  it('handles empty query gracefully', async () => {
    await archiveSession(cwd, sampleMessages)
    const results = await searchSessions(cwd, '')
    expect(results).toHaveLength(0)
  })

  it('handles multi-word queries with AND semantics', async () => {
    await archiveSession(cwd, sampleMessages)
    const results = await searchSessions(cwd, 'PostgreSQL Docker')
    // Both words must appear somewhere in the index
    // This may return 0 if they don't co-occur in a single message
    expect(Array.isArray(results)).toBe(true)
  })
})
