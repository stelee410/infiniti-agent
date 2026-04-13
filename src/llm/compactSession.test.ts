import { describe, it, expect } from 'vitest'
import { validateMessageSuffix, findSafeCompactSplitIndex } from './compactSession.js'
import type { PersistedMessage } from './persisted.js'

describe('validateMessageSuffix', () => {
  it('accepts empty suffix', () => {
    const msgs: PersistedMessage[] = [{ role: 'user', content: 'hi' }]
    expect(validateMessageSuffix(msgs, msgs.length)).toBe(true)
  })

  it('rejects suffix starting with tool message', () => {
    const msgs: PersistedMessage[] = [
      { role: 'tool', toolCallId: '1', name: 'bash', content: 'ok' },
    ]
    expect(validateMessageSuffix(msgs, 0)).toBe(false)
  })

  it('accepts user-only suffix', () => {
    const msgs: PersistedMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'user', content: 'hello' },
    ]
    expect(validateMessageSuffix(msgs, 0)).toBe(true)
  })

  it('accepts assistant with matching tool results', () => {
    const msgs: PersistedMessage[] = [
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: 'c1', name: 'bash', argumentsJson: '{}' },
          { id: 'c2', name: 'read', argumentsJson: '{}' },
        ],
      },
      { role: 'tool', toolCallId: 'c1', name: 'bash', content: 'ok1' },
      { role: 'tool', toolCallId: 'c2', name: 'read', content: 'ok2' },
    ]
    expect(validateMessageSuffix(msgs, 0)).toBe(true)
  })

  it('rejects when tool result id does not match', () => {
    const msgs: PersistedMessage[] = [
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', name: 'bash', argumentsJson: '{}' }],
      },
      { role: 'tool', toolCallId: 'wrong', name: 'bash', content: 'ok' },
    ]
    expect(validateMessageSuffix(msgs, 0)).toBe(false)
  })

  it('rejects when tool result is missing', () => {
    const msgs: PersistedMessage[] = [
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: 'c1', name: 'bash', argumentsJson: '{}' },
          { id: 'c2', name: 'read', argumentsJson: '{}' },
        ],
      },
      { role: 'tool', toolCallId: 'c1', name: 'bash', content: 'ok' },
    ]
    expect(validateMessageSuffix(msgs, 0)).toBe(false)
  })

  it('validates from a specific start index', () => {
    const msgs: PersistedMessage[] = [
      { role: 'tool', toolCallId: '0', name: 'x', content: 'bad' },
      { role: 'user', content: 'hi' },
    ]
    expect(validateMessageSuffix(msgs, 0)).toBe(false)
    expect(validateMessageSuffix(msgs, 1)).toBe(true)
  })
})

describe('findSafeCompactSplitIndex', () => {
  it('returns null for single message', () => {
    const msgs: PersistedMessage[] = [{ role: 'user', content: 'hi' }]
    expect(findSafeCompactSplitIndex(msgs, 4)).toBeNull()
  })

  it('returns null for empty array', () => {
    expect(findSafeCompactSplitIndex([], 4)).toBeNull()
  })

  it('finds split preserving at least minTailMessages', () => {
    const msgs: PersistedMessage[] = []
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: 'user', content: `msg ${i}` })
      msgs.push({ role: 'assistant', content: `reply ${i}` })
    }
    const split = findSafeCompactSplitIndex(msgs, 4)
    expect(split).not.toBeNull()
    expect(split!).toBeGreaterThan(0)
    expect(msgs.length - split!).toBeGreaterThanOrEqual(4)
  })

  it('enforces minimum 4 tail messages', () => {
    const msgs: PersistedMessage[] = []
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: 'user', content: `m${i}` })
      msgs.push({ role: 'assistant', content: `r${i}` })
    }
    const split = findSafeCompactSplitIndex(msgs, 1)
    expect(split).not.toBeNull()
    expect(msgs.length - split!).toBeGreaterThanOrEqual(4)
  })

  it('does not split in the middle of tool chain', () => {
    const msgs: PersistedMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'r1' },
      { role: 'user', content: 'do something' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', name: 'bash', argumentsJson: '{}' }],
      },
      { role: 'tool', toolCallId: 'c1', name: 'bash', content: 'done' },
      { role: 'assistant', content: 'complete' },
      { role: 'user', content: 'thanks' },
      { role: 'assistant', content: 'np' },
    ]
    const split = findSafeCompactSplitIndex(msgs, 2)
    if (split !== null) {
      expect(validateMessageSuffix(msgs, split)).toBe(true)
      expect(msgs[split]!.role).not.toBe('tool')
    }
  })

  it('returns null when cannot find valid split', () => {
    const msgs: PersistedMessage[] = [
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', name: 'bash', argumentsJson: '{}' }],
      },
      { role: 'tool', toolCallId: 'c1', name: 'bash', content: 'ok' },
    ]
    expect(findSafeCompactSplitIndex(msgs, 4)).toBeNull()
  })
})
