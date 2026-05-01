import { describe, expect, it } from 'vitest'
import {
  configPanelLayoutAction,
  isWindowSizeRestored,
  shouldApplyReal2dResizeLayout,
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

  it('ignores config-panel resize noise until the panel is closing back to the avatar window', () => {
    expect(shouldApplyReal2dResizeLayout({
      configPanelOpen: true,
      pendingConfigPanelCloseRestore: false,
      closeWindowRestored: false,
    })).toBe(false)
    expect(shouldApplyReal2dResizeLayout({
      configPanelOpen: false,
      pendingConfigPanelCloseRestore: true,
      closeWindowRestored: false,
    })).toBe(false)
    expect(shouldApplyReal2dResizeLayout({
      configPanelOpen: false,
      pendingConfigPanelCloseRestore: true,
      closeWindowRestored: true,
    })).toBe(true)
  })

  it('detects when the config panel close has restored the avatar window size', () => {
    expect(isWindowSizeRestored({ width: 954, height: 768 }, { width: 954, height: 768 })).toBe(true)
    expect(isWindowSizeRestored({ width: 956, height: 765 }, { width: 954, height: 768 })).toBe(true)
    expect(isWindowSizeRestored({ width: 954, height: 720 }, { width: 954, height: 768 })).toBe(false)
  })

  it('uses saved-close layout reset semantics when cancel closes the config panel', () => {
    expect(shouldResetReal2dCompactScaleOnConfigClose(false, 'cancel')).toBe(true)
  })

  it('resets Real2D compact scale compensation after a saved config close', () => {
    expect(shouldResetReal2dCompactScaleOnConfigClose(false, 'saved')).toBe(true)
  })

  it('does not reset Real2D compact scale compensation while the config panel opens', () => {
    expect(shouldResetReal2dCompactScaleOnConfigClose(true)).toBe(false)
  })
})
