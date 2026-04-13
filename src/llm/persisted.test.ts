import { describe, it, expect } from 'vitest'
import { truncateToolResults } from './persisted.js'
import type { PersistedMessage } from './persisted.js'

describe('truncateToolResults', () => {
  it('returns same messages when tool content is within limit', () => {
    const msgs: PersistedMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'tool', toolCallId: '1', name: 'bash', content: 'short' },
    ]
    const result = truncateToolResults(msgs)
    expect(result).toEqual(msgs)
  })

  it('does not modify original array', () => {
    const original: PersistedMessage[] = [
      { role: 'tool', toolCallId: '1', name: 'bash', content: 'x'.repeat(10000) },
    ]
    const originalContent = original[0]!.role === 'tool' ? (original[0] as Extract<PersistedMessage, { role: 'tool' }>).content : ''
    truncateToolResults(original)
    const afterContent = original[0]!.role === 'tool' ? (original[0] as Extract<PersistedMessage, { role: 'tool' }>).content : ''
    expect(afterContent).toBe(originalContent)
  })

  it('truncates tool content exceeding default 8000 chars', () => {
    const longContent = 'a'.repeat(10000)
    const msgs: PersistedMessage[] = [
      { role: 'tool', toolCallId: '1', name: 'http_request', content: longContent },
    ]
    const result = truncateToolResults(msgs)
    const tool = result[0] as Extract<PersistedMessage, { role: 'tool' }>
    expect(tool.content.length).toBeLessThan(longContent.length)
    expect(tool.content).toContain('…（已截断，原始 10000 字符）')
    expect(tool.content.startsWith('a'.repeat(8000))).toBe(true)
  })

  it('respects custom maxChars parameter', () => {
    const content = 'b'.repeat(500)
    const msgs: PersistedMessage[] = [
      { role: 'tool', toolCallId: '1', name: 'test', content },
    ]
    const result = truncateToolResults(msgs, 200)
    const tool = result[0] as Extract<PersistedMessage, { role: 'tool' }>
    expect(tool.content).toContain('…（已截断，原始 500 字符）')
    expect(tool.content.startsWith('b'.repeat(200))).toBe(true)
  })

  it('does not touch user or assistant messages', () => {
    const msgs: PersistedMessage[] = [
      { role: 'user', content: 'u'.repeat(20000) },
      { role: 'assistant', content: 'a'.repeat(20000) },
    ]
    const result = truncateToolResults(msgs)
    expect(result).toEqual(msgs)
  })

  it('handles mixed message types correctly', () => {
    const msgs: PersistedMessage[] = [
      { role: 'user', content: 'prompt' },
      { role: 'assistant', content: 'calling', toolCalls: [{ id: '1', name: 'bash', argumentsJson: '{}' }] },
      { role: 'tool', toolCallId: '1', name: 'bash', content: 'c'.repeat(100) },
      { role: 'tool', toolCallId: '2', name: 'http', content: 'd'.repeat(10000) },
    ]
    const result = truncateToolResults(msgs)
    expect(result[0]).toEqual(msgs[0])
    expect(result[1]).toEqual(msgs[1])
    expect((result[2] as Extract<PersistedMessage, { role: 'tool' }>).content).toBe('c'.repeat(100))
    expect((result[3] as Extract<PersistedMessage, { role: 'tool' }>).content).toContain('…（已截断')
  })

  it('preserves toolCallId and name on truncated messages', () => {
    const msgs: PersistedMessage[] = [
      { role: 'tool', toolCallId: 'call-xyz', name: 'http_request', content: 'e'.repeat(10000) },
    ]
    const result = truncateToolResults(msgs)
    const tool = result[0] as Extract<PersistedMessage, { role: 'tool' }>
    expect(tool.toolCallId).toBe('call-xyz')
    expect(tool.name).toBe('http_request')
  })
})
