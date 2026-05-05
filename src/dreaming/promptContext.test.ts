import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadDreamPromptContext, saveDreamPromptContext } from './dreamStore.js'
import { dreamPromptContextToPromptBlock } from './promptContext.js'

describe('dream prompt context', () => {
  it('normalizes persisted context to avoid prompt flooding', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'infiniti-dream-context-test-'))
    try {
      const long = 'x'.repeat(2000)
      await saveDreamPromptContext(cwd, {
        updatedAt: '2026-05-05T04:00:00.000Z',
        longHorizonObjective: long,
        recentInsight: long,
        relevantStableMemories: Array.from({ length: 20 }, (_, i) => `memory ${i} ${long}`),
        behaviorGuidance: Array.from({ length: 20 }, (_, i) => `guidance ${i} ${long}`),
        unresolvedThreads: Array.from({ length: 20 }, (_, i) => `thread ${i} ${long}`),
        cautions: Array.from({ length: 20 }, (_, i) => `caution ${i} ${long}`),
      })

      const raw = await readFile(join(cwd, '.infiniti-agent', 'dreams', 'prompt-context.json'), 'utf8')
      expect(raw.length).toBeLessThan(9000)

      const loaded = await loadDreamPromptContext(cwd)
      expect(loaded?.relevantStableMemories).toHaveLength(6)
      expect(loaded?.longHorizonObjective?.length).toBe(320)

      const block = dreamPromptContextToPromptBlock(loaded)
      expect(block).toContain('## Dream Context')
      expect(block.length).toBeLessThanOrEqual(5000)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
