import { describe, expect, it } from 'vitest'
import { extractGeminiResponseParts } from './geminiResponseParts.js'

describe('extractGeminiResponseParts', () => {
  it('merges text chunks and extracts function calls', () => {
    expect(extractGeminiResponseParts([
      { text: ' hello ' },
      { text: 'world ' },
      { functionCall: { name: 'read_file', args: { path: 'a' } } },
    ])).toEqual({
      mergedText: 'hello world',
      calls: [{ name: 'read_file', args: { path: 'a' } }],
    })
  })

  it('ignores malformed function calls and normalizes missing args', () => {
    expect(extractGeminiResponseParts([
      { text: '   ' },
      { functionCall: { name: '', args: { x: 1 } } },
      { functionCall: { name: 'list_files', args: ['bad'] } },
      { functionCall: { name: 'grep' } },
    ])).toEqual({
      mergedText: null,
      calls: [
        { name: 'list_files', args: {} },
        { name: 'grep', args: {} },
      ],
    })
  })
})
