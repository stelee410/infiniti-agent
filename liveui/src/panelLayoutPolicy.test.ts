import { describe, expect, it } from 'vitest'
import {
  configPanelLayoutAction,
  shouldResetReal2dCompactScaleOnConfigClose,
  shouldRunDynamicFigureFit,
} from './panelLayoutPolicy.ts'

describe('panelLayoutPolicy', () => {
  it('suspends figure fitting while the config panel is open', () => {
    expect(configPanelLayoutAction(true)).toBe('suspend-fit')
    expect(shouldRunDynamicFigureFit({ minimalMode: false, configPanelOpen: true })).toBe(false)
  })

  it('refreshes normal layout after the config panel closes', () => {
    expect(configPanelLayoutAction(false)).toBe('refresh-normal-layout')
    expect(shouldRunDynamicFigureFit({ minimalMode: false, configPanelOpen: false })).toBe(true)
  })

  it('still allows minimal-mode bounds sync while the panel is open', () => {
    expect(shouldRunDynamicFigureFit({ minimalMode: true, configPanelOpen: true })).toBe(true)
  })

  it('resets Real2D compact scale compensation when cancel closes the config panel', () => {
    expect(shouldResetReal2dCompactScaleOnConfigClose(false, 'cancel')).toBe(true)
  })

  it('does not reset Real2D compact scale compensation while the config panel opens', () => {
    expect(shouldResetReal2dCompactScaleOnConfigClose(true)).toBe(false)
  })
})
