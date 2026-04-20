import { describe, expect, it } from 'vitest'
import { parseEmotionIntensityFromText } from './emotionIntensity.js'

describe('parseEmotionIntensityFromText', () => {
  it('解析多个标签并取最大强度', () => {
    const r = parseEmotionIntensityFromText('[Smile] 你好 [Happy]')
    expect(r.tags).toEqual(['Smile', 'Happy'])
    expect(r.maxIntensity).toBe(0.9)
  })
})
