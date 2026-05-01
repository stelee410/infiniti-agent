import { describe, expect, it } from 'vitest'
import {
  clampSlashSelection,
  slashInsertText,
  slashMenuHintText,
  slashMenuWindow,
} from './slashMenuModel.ts'

describe('slashMenuModel', () => {
  it('clamps selection for empty and non-empty lists', () => {
    expect(clampSlashSelection(0, 99)).toBe(0)
    expect(clampSlashSelection(3, -1)).toBe(0)
    expect(clampSlashSelection(3, 9)).toBe(2)
  })

  it('computes a stable visible window around the selected row', () => {
    const rows = Array.from({ length: 10 }, (_, i) => i)
    expect(slashMenuWindow(rows, 0, 4)).toEqual({ selected: 0, start: 0, visible: [0, 1, 2, 3] })
    expect(slashMenuWindow(rows, 5, 4)).toEqual({ selected: 5, start: 3, visible: [3, 4, 5, 6] })
    expect(slashMenuWindow(rows, 9, 4)).toEqual({ selected: 9, start: 6, visible: [6, 7, 8, 9] })
  })

  it('formats hints and inserted text', () => {
    expect(slashMenuHintText(0)).toContain('无匹配项')
    expect(slashMenuHintText(3)).toContain('共 3 项')
    expect(slashInsertText('/config')).toBe('/config ')
    expect(slashInsertText('/config ')).toBe('/config ')
  })
})
