import { describe, expect, it, vi } from 'vitest'
import type { InfinitiConfig } from '../config/types.js'
import type { PersistedMessage } from '../llm/persisted.js'
import { maybeStartAutoCompaction, mergeCompactedPrefixWithLatest } from './chatAutoCompaction.js'

function config(autoThresholdTokens: number): InfinitiConfig {
  return {
    version: 1,
    llm: {
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'sk-test',
    },
    compaction: {
      autoThresholdTokens,
      minTailMessages: 5,
      maxToolSnippetChars: 1000,
      preCompactHook: './hook.sh',
    },
  }
}

function ui() {
  return {
    setCompacting: vi.fn(),
    setNotice: vi.fn(),
    setError: vi.fn(),
    setBusy: vi.fn(),
    setMessages: vi.fn(),
    clearNoticeLater: vi.fn(),
  }
}

const messages: PersistedMessage[] = [
  { role: 'user', content: 'hello '.repeat(50) },
  { role: 'assistant', content: 'world '.repeat(50) },
]

describe('maybeStartAutoCompaction', () => {
  it('skips when the threshold is disabled or not reached', () => {
    const u = ui()
    expect(maybeStartAutoCompaction({
      cwd: '/tmp/project',
      config: config(0),
      messages,
      controller: null,
      ui: u,
    })).toBe(false)
    expect(u.setCompacting).not.toHaveBeenCalled()
  })

  it('starts controller-backed compaction and updates UI when it completes', async () => {
    const u = ui()
    const next = [{ role: 'assistant' as const, content: 'summary' }]
    const controller = { compactSessionAsync: vi.fn().mockResolvedValue(next) }

    expect(maybeStartAutoCompaction({
      cwd: '/tmp/project',
      config: config(1),
      messages,
      controller,
      ui: u,
    })).toBe(true)
    await vi.waitFor(() => {
      expect(u.setMessages).toHaveBeenCalledWith(next)
    })

    expect(controller.compactSessionAsync).toHaveBeenCalledWith({
      messages,
      minTailMessages: 5,
      maxToolSnippetChars: 1000,
      preCompactHook: './hook.sh',
    })
    expect(u.setCompacting).toHaveBeenNthCalledWith(1, true)
    expect(u.setNotice).toHaveBeenCalledWith('历史较长，已提交后台压缩；本轮继续使用当前上下文…')
    expect(u.clearNoticeLater).toHaveBeenCalledWith(5000)
    expect(u.setCompacting).toHaveBeenLastCalledWith(false)
  })

  it('reports async compaction errors without blocking the current turn', async () => {
    const u = ui()
    const controller = { compactSessionAsync: vi.fn().mockRejectedValue(new Error('boom')) }

    expect(maybeStartAutoCompaction({
      cwd: '/tmp/project',
      config: config(1),
      messages,
      controller,
      ui: u,
    })).toBe(true)
    await vi.waitFor(() => {
      expect(u.setError).toHaveBeenCalledWith('boom')
    })

    expect(u.setNotice).toHaveBeenLastCalledWith(null)
    expect(u.setBusy).not.toHaveBeenCalled()
    expect(u.setCompacting).toHaveBeenLastCalledWith(false)
  })

  it('does not start another compaction while one is already running', () => {
    const u = ui()
    const controller = { compactSessionAsync: vi.fn() }

    expect(maybeStartAutoCompaction({
      cwd: '/tmp/project',
      config: config(1),
      messages,
      controller,
      compacting: true,
      ui: u,
    })).toBe(false)

    expect(controller.compactSessionAsync).not.toHaveBeenCalled()
    expect(u.setCompacting).not.toHaveBeenCalled()
  })

  it('does not immediately compact an already compacted tail-sized session again', () => {
    const u = ui()
    const compacted: PersistedMessage[] = [
      { role: 'user', content: '## [会话压缩摘要]\n\nsummary' },
      { role: 'assistant', content: 'recent 1' },
      { role: 'user', content: 'recent 2' },
      { role: 'assistant', content: 'recent 3' },
    ]

    expect(maybeStartAutoCompaction({
      cwd: '/tmp/project',
      config: config(1),
      messages: compacted,
      controller: { compactSessionAsync: vi.fn() },
      ui: u,
    })).toBe(false)

    expect(u.setCompacting).not.toHaveBeenCalled()
  })

  it('merges a compacted prefix with messages added while compaction was running', () => {
    const originalBase: PersistedMessage[] = [
      { role: 'user', content: 'old 1' },
      { role: 'assistant', content: 'old 2' },
    ]
    const compactedBase: PersistedMessage[] = [
      { role: 'user', content: '## [会话压缩摘要]\n\nold summary' },
    ]
    const latest: PersistedMessage[] = [
      ...originalBase,
      { role: 'user', content: 'new question' },
      { role: 'assistant', content: 'new answer' },
    ]

    expect(mergeCompactedPrefixWithLatest(compactedBase, originalBase, latest)).toEqual([
      ...compactedBase,
      { role: 'user', content: 'new question' },
      { role: 'assistant', content: 'new answer' },
    ])
  })
})
