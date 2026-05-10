import { describe, expect, it } from 'vitest'
import {
  configPanelLayoutAction,
  isWindowSizeRestored,
  shouldApplyReal2dResizeLayout,
  shouldFreezeReal2dStageLayoutForH5,
  shouldResetReal2dCompactScaleOnConfigClose,
  shouldRunDynamicFigureFit,
} from './panelLayoutPolicy.ts'
import {
  computeReal2dRuntimeStageHeight,
  computeReal2dStageHeight,
} from './figureManager.ts'

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

  it('suspends figure fitting for non-config full-window overlays', () => {
    expect(shouldRunDynamicFigureFit({ minimalMode: false, layoutSuspended: true })).toBe(false)
    expect(shouldApplyReal2dResizeLayout({
      layoutSuspended: true,
      pendingConfigPanelCloseRestore: false,
      closeWindowRestored: false,
    })).toBe(false)
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

  it('freezes real2d stage layout while a H5 applet is open or restoring', () => {
    expect(shouldFreezeReal2dStageLayoutForH5({
      h5AppletOpen: true,
      pendingH5AppletCloseWindowSize: null,
    })).toBe(true)
    expect(shouldFreezeReal2dStageLayoutForH5({
      h5AppletOpen: false,
      pendingH5AppletCloseWindowSize: { width: 954, height: 768 },
    })).toBe(true)
    expect(shouldFreezeReal2dStageLayoutForH5({
      h5AppletOpen: false,
      pendingH5AppletCloseWindowSize: null,
    })).toBe(false)
  })
})

describe('H5 applet stage-layout regression: real2dStableStageHeight must not saturate to viewport while dock is hidden', () => {
  // 真实 bug：当 H5 快应用打开时，body.liveui-h5-applet-open 用 display:none !important
  // 隐藏 #liveui-bottom-dock，于是 controlBar.getBoundingClientRect().top = 0。
  // 如果此刻 applyReal2dStageLayout 仍被调用（例如 Enter 提交触发 refreshNormal 的 90ms 重试链），
  // computeReal2dStageHeight 会返回 viewportHeight 全高，进而把 stable 单调推升到工作区高度，
  // H5 关闭后 avatar canvas 残留过大导致人物视觉变大。

  function applyStage(state: { stable: number }, env: { viewportHeight: number; controlBarTop: number | null }): {
    stable: number
    runtime: number
  } {
    const current = computeReal2dStageHeight(env.viewportHeight, env.controlBarTop)
    const next = computeReal2dRuntimeStageHeight({
      currentStageHeight: current,
      stableStageHeight: state.stable,
      minimalMode: false,
    })
    return { stable: next.stableStageHeight, runtime: next.runtimeStageHeight }
  }

  it('reproduces the saturation when applyReal2dStageLayout runs with controlBar hidden', () => {
    // controlBar 可见时，正常 stable 维持在 ~620。
    let state = { stable: 0 }
    state = applyStage(state, { viewportHeight: 800, controlBarTop: 620 })
    expect(state.stable).toBe(620)

    // 模拟 H5 打开后 dock 被隐藏（rect.top = 0），且窗口已扩到工作区。
    // 这里就是没有 freeze 的情况下的 bug：stable 被推升到 1080。
    state = applyStage(state, { viewportHeight: 1080, controlBarTop: 0 })
    expect(state.stable).toBe(1080)

    // 关闭 H5、窗口缩回 800，正常 stage 再次 ~620。
    // 但 stable 已被钉死在 1080，runtime 取 max → 1080，avatar canvas 被放大。
    state = applyStage(state, { viewportHeight: 800, controlBarTop: 620 })
    expect(state.runtime).toBe(1080)
    expect(state.stable).toBe(1080)
  })

  it('with the H5 freeze guard skipping applyReal2dStageLayout, stable is preserved across the full open/close cycle', () => {
    // 修复：shouldFreezeReal2dStageLayoutForH5 在 H5 生命周期内为 true，
    // applyReal2dStageLayout 提前 return，state 保持不变。
    const initial = { stable: 620 }

    // H5 打开瞬间——guard 命中，跳过更新。
    let state = shouldFreezeReal2dStageLayoutForH5({
      h5AppletOpen: true,
      pendingH5AppletCloseWindowSize: null,
    })
      ? initial
      : applyStage(initial, { viewportHeight: 1080, controlBarTop: 0 })
    expect(state).toEqual({ stable: 620 })

    // H5 关闭还原阶段——guard 仍然命中（pendingH5AppletCloseWindowSize 非空），跳过。
    state = shouldFreezeReal2dStageLayoutForH5({
      h5AppletOpen: false,
      pendingH5AppletCloseWindowSize: { width: 600, height: 800 },
    })
      ? state
      : applyStage(state, { viewportHeight: 800, controlBarTop: 0 })
    expect(state).toEqual({ stable: 620 })

    // H5 完成关闭，guard 释放，正常更新继续；avatar 状态与打开前完全一致。
    const finalState = applyStage(state, { viewportHeight: 800, controlBarTop: 620 })
    expect(finalState.stable).toBe(620)
    expect(finalState.runtime).toBe(620)
  })
})
