import { describe, it, expect } from 'vitest'
import { estimateTextTokens, estimateMessagesTokens } from './estimateTokens.js'
import type { PersistedMessage } from './persisted.js'

describe('estimateTextTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTextTokens('')).toBe(0)
  })

  it('returns 0 for null/undefined-ish', () => {
    expect(estimateTextTokens(null as unknown as string)).toBe(0)
    expect(estimateTextTokens(undefined as unknown as string)).toBe(0)
  })

  it('estimates pure ASCII at ~length/4', () => {
    const text = 'hello world 1234'
    const tokens = estimateTextTokens(text)
    expect(tokens).toBe(Math.ceil(text.length / 4))
  })

  it('estimates pure CJK higher than length/4', () => {
    const text = '你好世界这是一段中文测试'
    const tokensNew = estimateTextTokens(text)
    const oldEstimate = Math.ceil(text.length / 4)
    expect(tokensNew).toBeGreaterThan(oldEstimate)
    expect(tokensNew).toBe(Math.ceil(text.length / 1.5))
  })

  it('estimates mixed CJK + ASCII between the two extremes', () => {
    const cjk = '你好世界'
    const ascii = ' hello world'
    const text = cjk + ascii
    const tokens = estimateTextTokens(text)
    const pureCjkRate = Math.ceil(text.length / 1.5)
    const pureAsciiRate = Math.ceil(text.length / 4)
    expect(tokens).toBeGreaterThan(pureAsciiRate)
    expect(tokens).toBeLessThan(pureCjkRate)
  })

  it('handles CJK unified ideographs range', () => {
    // U+4E00 - U+9FFF
    expect(estimateTextTokens('\u4e00\u9fff')).toBe(Math.ceil(2 / 1.5))
  })

  it('handles CJK compatibility (U+F900-U+FAFF)', () => {
    expect(estimateTextTokens('\uf900\ufaff')).toBe(Math.ceil(2 / 1.5))
  })
})

describe('estimateMessagesTokens', () => {
  it('sums tokens from user messages', () => {
    const msgs: PersistedMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'user', content: '你好' },
    ]
    const total = estimateMessagesTokens(msgs)
    expect(total).toBe(
      estimateTextTokens('hello') + estimateTextTokens('你好'),
    )
  })

  it('handles assistant with null content', () => {
    const msgs: PersistedMessage[] = [
      { role: 'assistant', content: null },
    ]
    expect(estimateMessagesTokens(msgs)).toBe(0)
  })

  it('includes assistant toolCalls in estimate', () => {
    const msgs: PersistedMessage[] = [
      {
        role: 'assistant',
        content: 'calling tool',
        toolCalls: [
          { id: '1', name: 'bash', argumentsJson: '{"cmd":"ls"}' },
        ],
      },
    ]
    const total = estimateMessagesTokens(msgs)
    expect(total).toBe(
      estimateTextTokens('calling tool') +
      estimateTextTokens('bash') +
      estimateTextTokens('{"cmd":"ls"}'),
    )
  })

  it('includes tool message name and content', () => {
    const msgs: PersistedMessage[] = [
      { role: 'tool', toolCallId: '1', name: 'bash', content: 'file1\nfile2' },
    ]
    const total = estimateMessagesTokens(msgs)
    expect(total).toBe(
      estimateTextTokens('bash') + estimateTextTokens('file1\nfile2'),
    )
  })
})
