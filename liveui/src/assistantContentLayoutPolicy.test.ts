import { describe, expect, it } from 'vitest'
import {
  computeAssistantContentLayoutPlan,
  estimateAssistantBubbleLines,
} from './assistantContentLayoutPolicy.ts'

describe('assistantContentLayoutPolicy', () => {
  it('keeps short assistant replies compact', () => {
    expect(estimateAssistantBubbleLines('好的，马上来。')).toBe(2)
    expect(computeAssistantContentLayoutPlan({
      text: '好的，马上来。',
      barHeight: 120,
      viewportHeight: 580,
      minimalMode: false,
    })).toEqual({
      bubbleLines: 2,
      minWindowHeight: 360,
    })
  })

  it('expands the bubble and minimum window height for long replies', () => {
    const text = '这是一段比较长的回复。'.repeat(28)
    const plan = computeAssistantContentLayoutPlan({
      text,
      barHeight: 120,
      viewportHeight: 720,
      minimalMode: false,
    })

    expect(plan.bubbleLines).toBeGreaterThan(3)
    expect(plan.minWindowHeight).toBeGreaterThan(360)
  })

  it('uses hard line breaks as a signal for visible lines', () => {
    expect(estimateAssistantBubbleLines('第一行\n第二行\n第三行\n第四行')).toBe(4)
  })

  it('does not expand the speech bubble in minimal mode', () => {
    const plan = computeAssistantContentLayoutPlan({
      text: '长回复'.repeat(100),
      barHeight: 80,
      viewportHeight: 320,
      minimalMode: true,
    })

    expect(plan.bubbleLines).toBe(3)
  })
})
