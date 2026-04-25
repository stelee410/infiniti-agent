import { describe, expect, it } from 'vitest'
import {
  collectNewTtsSegments,
  splitTtsSegments,
  splitTtsSegmentsWithSpans,
} from './streamSegments.js'

describe('stream TTS segmentation', () => {
  it('streams settled segments and finalizes only the tail', () => {
    let cursor = 0

    const first = collectNewTtsSegments('第一句。第二', cursor)
    expect(first.segments).toEqual(['第一句。'])
    cursor = first.cursor

    const repeatedDelta = collectNewTtsSegments('第一句。第二句。', cursor)
    expect(repeatedDelta.segments).toEqual([])
    cursor = repeatedDelta.cursor

    const final = collectNewTtsSegments('第一句。第二句。', cursor, { final: true })
    expect(final.segments).toEqual(['第二句。'])
  })

  it('does not dedupe intentional repeated text at different positions', () => {
    let cursor = 0

    const first = collectNewTtsSegments('好的。好的', cursor)
    expect(first.segments).toEqual(['好的。'])
    cursor = first.cursor

    const final = collectNewTtsSegments('好的。好的。', cursor, { final: true })
    expect(final.segments).toEqual(['好的。'])
  })

  it('keeps spans aligned with source text', () => {
    const text = '  A。  B。'
    expect(splitTtsSegments(text)).toEqual(['A。', 'B。'])
    expect(splitTtsSegmentsWithSpans(text).map((s) => [s.text, s.start, s.end])).toEqual([
      ['A。', 2, 4],
      ['B。', 6, 8],
    ])
  })

  it('chunks long text without replaying previous chunks on finalization', () => {
    const text = `${'a'.repeat(120)}。`
    const first = collectNewTtsSegments(text, 0)
    expect(first.segments).toEqual(['a'.repeat(96)])

    const final = collectNewTtsSegments(text, first.cursor, { final: true })
    expect(final.segments).toEqual([`${'a'.repeat(24)}。`])
  })
})
