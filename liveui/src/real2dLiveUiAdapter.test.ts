import { describe, expect, it } from 'vitest'
import { Real2dLiveUiAdapter } from './real2dLiveUiAdapter.ts'

function createAdapter(): { adapter: Real2dLiveUiAdapter; style: CSSStyleDeclaration } {
  const style = {} as CSSStyleDeclaration
  const container = { style } as HTMLElement
  return {
    adapter: new Real2dLiveUiAdapter({
      container,
      spriteExpressionDirFileUrl: 'file:///tmp/avatar/',
      width: 400,
      height: 600,
    }),
    style,
  }
}

describe('Real2dLiveUiAdapter', () => {
  it('exposes the current compact stage scale compensation for layout restore', () => {
    const { adapter, style } = createAdapter()

    adapter.setStageScaleCompensation(1.25)

    expect(adapter.getStageScaleCompensation()).toBe(1.25)
    expect(style.transform).toBe('translateY(0px) scale(1.25)')
  })

  it('clamps restored compact stage scale compensation to supported bounds', () => {
    const { adapter } = createAdapter()

    adapter.setStageScaleCompensation(3)

    expect(adapter.getStageScaleCompensation()).toBe(1.6)
  })
})
