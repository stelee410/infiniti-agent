import { describe, expect, it } from 'vitest'
import {
  canNavigateInputHistory,
  navigateInputHistory,
  parseInputHistory,
  rememberInput,
} from './inputHistory.ts'

describe('inputHistory', () => {
  it('parses stored input history defensively', () => {
    expect(parseInputHistory('["a", "", 1, "b", "c"]', 2)).toEqual(['b', 'c'])
    expect(parseInputHistory('not json', 10)).toEqual([])
    expect(parseInputHistory('{"x":1}', 10)).toEqual([])
  })

  it('remembers non-empty inputs without duplicating the latest entry', () => {
    expect(rememberInput(['a'], '  ', 10)).toEqual({ items: ['a'], index: 1, draft: '' })
    expect(rememberInput(['a'], 'a', 10)).toEqual({ items: ['a'], index: 1, draft: '' })
    expect(rememberInput(['a', 'b'], 'c', 2)).toEqual({ items: ['b', 'c'], index: 2, draft: '' })
  })

  it('prevents history navigation through multiline text boundaries', () => {
    expect(canNavigateInputHistory('up', 'a\nb', 3, 2)).toBe(false)
    expect(canNavigateInputHistory('up', 'a\nb', 1, 2)).toBe(true)
    expect(canNavigateInputHistory('down', 'a\nb', 1, 2)).toBe(false)
    expect(canNavigateInputHistory('down', 'a\nb', 3, 2)).toBe(true)
  })

  it('navigates history while preserving the draft input', () => {
    const state = { items: ['one', 'two'], index: 2, draft: '' }
    const up = navigateInputHistory(state, 'up', 'draft')
    expect(up).toEqual({ items: ['one', 'two'], index: 1, draft: 'draft', value: 'two', changed: true })
    const upAgain = navigateInputHistory(up, 'up', 'two')
    expect(upAgain.value).toBe('one')
    const down = navigateInputHistory(upAgain, 'down', 'one')
    expect(down.value).toBe('two')
    const backToDraft = navigateInputHistory(down, 'down', 'two')
    expect(backToDraft.value).toBe('draft')
  })
})
