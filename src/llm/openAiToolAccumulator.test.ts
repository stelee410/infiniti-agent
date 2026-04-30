import { describe, expect, it } from 'vitest'
import { OpenAiToolAccumulator } from './openAiToolAccumulator.js'

describe('OpenAiToolAccumulator', () => {
  it('accumulates streamed tool call deltas by index and preserves order', () => {
    const acc = new OpenAiToolAccumulator()
    acc.add({ index: 1, id: 'call-b', function: { name: 'grep', arguments: '{"q":"' } })
    acc.add({ index: 0, id: 'call-a', function: { name: 'read_file', arguments: '{"path"' } })
    acc.add({ index: 1, function: { arguments: 'test"}' } })
    acc.add({ index: 0, function: { arguments: ':"a"}' } })

    expect(acc.toToolCalls()).toEqual([
      { id: 'call-a', name: 'read_file', argumentsJson: '{"path":"a"}' },
      { id: 'call-b', name: 'grep', argumentsJson: '{"q":"test"}' },
    ])
  })

  it('drops incomplete calls and normalizes missing arguments', () => {
    const acc = new OpenAiToolAccumulator()
    acc.add({ index: 0, id: 'missing-name' })
    acc.add({ index: 1, function: { name: 'missing-id' } })
    acc.add({ index: 2, id: 'ok', function: { name: 'list_files' } })

    expect(acc.toToolCalls()).toEqual([
      { id: 'ok', name: 'list_files', argumentsJson: '{}' },
    ])
  })
})
