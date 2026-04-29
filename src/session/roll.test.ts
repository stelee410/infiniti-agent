import { describe, expect, it } from 'vitest'
import type { PersistedMessage } from '../llm/persisted.js'
import { rollMessages } from './roll.js'

describe('rollMessages', () => {
  it('rolls one assistant layer with its preceding users', () => {
    const messages: PersistedMessage[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'user', content: 'u3' },
      { role: 'assistant', content: 'a2' },
    ]

    const res = rollMessages(messages, 1)
    expect(res.layers).toBe(1)
    expect(res.removed).toBe(3)
    expect(res.messages).toEqual(messages.slice(0, 2))
  })

  it('rolls tool chains with the assistant layer', () => {
    const messages: PersistedMessage[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: null, toolCalls: [{ id: 't1', name: 'bash', argumentsJson: '{}' }] },
      { role: 'tool', toolCallId: 't1', name: 'bash', content: 'out' },
      { role: 'assistant', content: 'a2' },
    ]

    const res = rollMessages(messages, 1)
    expect(res.layers).toBe(1)
    expect(res.messages).toEqual(messages.slice(0, 2))
  })

  it('rolls multiple layers', () => {
    const messages: PersistedMessage[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
      { role: 'assistant', content: 'a3' },
    ]

    const res = rollMessages(messages, 2)
    expect(res.layers).toBe(2)
    expect(res.messages).toEqual(messages.slice(0, 2))
  })

  it('stops when there are no assistant layers', () => {
    const messages: PersistedMessage[] = [{ role: 'user', content: 'u1' }]
    const res = rollMessages(messages, 3)
    expect(res.layers).toBe(0)
    expect(res.messages).toEqual(messages)
  })
})
