import { describe, it, expect } from 'vitest'
import { resolvedCompactionSettings, DEFAULT_MIN_TAIL_MESSAGES, DEFAULT_MAX_TOOL_SNIPPET_CHARS } from './compactionSettings.js'
import type { InfinitiConfig } from '../config/types.js'

function makeConfig(compaction?: InfinitiConfig['compaction']): InfinitiConfig {
  return {
    version: 1,
    llm: {
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'sk-test',
    },
    compaction,
  }
}

describe('resolvedCompactionSettings', () => {
  it('returns defaults when no compaction config', () => {
    const s = resolvedCompactionSettings(makeConfig())
    expect(s.autoThresholdTokens).toBe(0)
    expect(s.minTailMessages).toBe(DEFAULT_MIN_TAIL_MESSAGES)
    expect(s.maxToolSnippetChars).toBe(DEFAULT_MAX_TOOL_SNIPPET_CHARS)
    expect(s.preCompactHook).toBeUndefined()
  })

  it('returns defaults when compaction is empty object', () => {
    const s = resolvedCompactionSettings(makeConfig({}))
    expect(s.autoThresholdTokens).toBe(0)
    expect(s.minTailMessages).toBe(DEFAULT_MIN_TAIL_MESSAGES)
  })

  it('uses configured autoThresholdTokens', () => {
    const s = resolvedCompactionSettings(makeConfig({ autoThresholdTokens: 30000 }))
    expect(s.autoThresholdTokens).toBe(30000)
  })

  it('enforces minimum 4 for minTailMessages', () => {
    const s = resolvedCompactionSettings(makeConfig({ minTailMessages: 2 }))
    expect(s.minTailMessages).toBe(4)
  })

  it('enforces minimum 500 for maxToolSnippetChars', () => {
    const s = resolvedCompactionSettings(makeConfig({ maxToolSnippetChars: 100 }))
    expect(s.maxToolSnippetChars).toBe(500)
  })

  it('passes through preCompactHook', () => {
    const s = resolvedCompactionSettings(makeConfig({ preCompactHook: './hook.sh' }))
    expect(s.preCompactHook).toBe('./hook.sh')
  })

  it('normalizes blank preCompactHook to undefined', () => {
    const s = resolvedCompactionSettings(makeConfig({ preCompactHook: '  ' }))
    expect(s.preCompactHook).toBeUndefined()
  })
})
