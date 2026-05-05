import { describe, expect, it } from 'vitest'
import type { McpManager } from '../mcp/manager.js'
import { buildSlashItems, filterSlashItems } from './slashCompletions.js'

const emptyMcp = {
  getToolSpecs: () => [],
} as unknown as McpManager

describe('slash completions', () => {
  it('keeps hidden commands out of autocomplete while leaving visible commands', () => {
    const items = buildSlashItems(emptyMcp)
    const labels = items.map((item) => item.label)

    expect(labels).toContain('/schedule')
    expect(labels).not.toContain('/debug')
    expect(labels).not.toContain('/dream')
    expect(filterSlashItems(items, '/debug').map((item) => item.label)).not.toContain('/debug')
    expect(filterSlashItems(items, '/dream').map((item) => item.label)).not.toContain('/dream')
  })
})
