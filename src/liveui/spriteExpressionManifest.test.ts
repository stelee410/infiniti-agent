import { describe, expect, it } from 'vitest'
import {
  buildEmotionToSpriteIdFromManifest,
  buildLiveUiExpressionNudgeFromManifest,
  buildStripKnownEmotionTagsRegex,
  defaultLunaStyleManifest,
  parseSpriteExpressionManifest,
} from './spriteExpressionManifest.js'

describe('spriteExpressionManifest', () => {
  it('parses valid manifest', () => {
    const m = parseSpriteExpressionManifest({
      version: 1,
      entries: [{ id: 'exp_01', emotions: ['neutral', 'calm'] }],
    })
    expect(m.entries).toHaveLength(1)
  })

  it('builds emotion to sprite id map', () => {
    const m = defaultLunaStyleManifest()
    const map = buildEmotionToSpriteIdFromManifest(m)
    expect(map.happy).toBe('exp_03')
    expect(map.neutral).toBe('exp_01')
  })

  it('builds nudge containing bracket tags', () => {
    const n = buildLiveUiExpressionNudgeFromManifest(defaultLunaStyleManifest())
    expect(n).toContain('[Happy]')
    expect(n).toContain('[Neutral]')
  })

  it('strip regex removes manifest-only tag when passed manifest', () => {
    const m = parseSpriteExpressionManifest({
      version: 1,
      entries: [{ id: 'exp_99', emotions: ['weird'] }],
    })
    const re = buildStripKnownEmotionTagsRegex(m)
    expect('[Weird] hello'.replace(re, '')).toBe('hello')
  })
})
