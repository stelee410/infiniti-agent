import { describe, expect, it } from 'vitest'
import {
  configPanelLayoutAction,
  shouldApplyReal2dResizeLayout,
  shouldResetReal2dCompactScaleOnConfigClose,
  shouldRestoreReal2dCompactScaleOnConfigClose,
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

  it('ignores config-panel resize noise until the panel is closing back to the avatar window', () => {
    expect(shouldApplyReal2dResizeLayout({
      configPanelOpen: true,
      hasPendingConfigPanelRestore: false,
    })).toBe(false)
    expect(shouldApplyReal2dResizeLayout({
      configPanelOpen: false,
      hasPendingConfigPanelRestore: true,
    })).toBe(true)
  })

  it('resets Real2D compact scale compensation when cancel closes the config panel', () => {
    expect(shouldRestoreReal2dCompactScaleOnConfigClose(false, 'cancel')).toBe(true)
    expect(shouldResetReal2dCompactScaleOnConfigClose(false, 'cancel')).toBe(false)
  })

  it('resets Real2D compact scale compensation after a saved config close', () => {
    expect(shouldRestoreReal2dCompactScaleOnConfigClose(false, 'saved')).toBe(false)
    expect(shouldResetReal2dCompactScaleOnConfigClose(false, 'saved')).toBe(true)
  })

  it('does not reset Real2D compact scale compensation while the config panel opens', () => {
    expect(shouldResetReal2dCompactScaleOnConfigClose(true)).toBe(false)
    expect(shouldRestoreReal2dCompactScaleOnConfigClose(true)).toBe(false)
  })
})
