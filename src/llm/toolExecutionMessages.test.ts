import { describe, expect, it } from 'vitest'
import type { PersistedMessage } from './persisted.js'
import {
  appendAssistantToolCalls,
  appendPendingToolResults,
  appendToolResult,
  failedToolResultJson,
} from './toolExecutionMessages.js'

describe('toolExecutionMessages', () => {
  it('appends assistant tool call messages in persisted format', () => {
    const messages: PersistedMessage[] = []
    appendAssistantToolCalls(messages, null, [
      { id: 'call-1', name: 'read_file', argumentsJson: '{"path":"a"}' },
      { id: 'call-2', name: 'write_file', argumentsJson: '' },
    ])

    expect(messages).toEqual([
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: 'call-1', name: 'read_file', argumentsJson: '{"path":"a"}' },
          { id: 'call-2', name: 'write_file', argumentsJson: '{}' },
        ],
      },
    ])
  })

  it('appends direct and pending tool results in order', async () => {
    const messages: PersistedMessage[] = []
    appendToolResult(messages, { id: 'a', name: 'read_file' }, 'A')
    await appendPendingToolResults(messages, [
      { id: 'b', name: 'grep', argumentsJson: '{}', resultPromise: Promise.resolve('B') },
    ])

    expect(messages).toEqual([
      { role: 'tool', toolCallId: 'a', name: 'read_file', content: 'A' },
      { role: 'tool', toolCallId: 'b', name: 'grep', content: 'B' },
    ])
  })

  it('converts pending tool failures when an error formatter is provided', async () => {
    const messages: PersistedMessage[] = []
    await appendPendingToolResults(
      messages,
      [{ id: 'bad', name: 'bash', argumentsJson: '{}', resultPromise: Promise.reject(new Error('boom')) }],
      (e) => failedToolResultJson('stream_failed', e),
    )

    expect(messages).toEqual([
      {
        role: 'tool',
        toolCallId: 'bad',
        name: 'bash',
        content: JSON.stringify({ ok: false, status: 'stream_failed', error: 'boom' }),
      },
    ])
  })
})
