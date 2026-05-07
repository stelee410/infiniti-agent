export type ConfigPanelLayoutAction = 'suspend-fit' | 'refresh-normal-layout'
export type ConfigPanelCloseReason = 'cancel' | 'saved'
export type WindowSize = { width: number; height: number }

export function configPanelLayoutAction(open: boolean): ConfigPanelLayoutAction {
  return open ? 'suspend-fit' : 'refresh-normal-layout'
}

export function shouldRunDynamicFigureFit(state: {
  minimalMode: boolean
  configPanelOpen?: boolean
  layoutSuspended?: boolean
}): boolean {
  const layoutSuspended = state.layoutSuspended ?? Boolean(state.configPanelOpen)
  return state.minimalMode || !layoutSuspended
}

export function shouldApplyReal2dResizeLayout(state: {
  configPanelOpen?: boolean
  layoutSuspended?: boolean
  pendingConfigPanelCloseRestore: boolean
  closeWindowRestored: boolean
}): boolean {
  const layoutSuspended = state.layoutSuspended ?? Boolean(state.configPanelOpen)
  if (layoutSuspended) return false
  if (state.pendingConfigPanelCloseRestore) return state.closeWindowRestored
  return true
}

/**
 * 快应用打开/关闭整个生命周期内冻结 real2d stage 布局。
 * 否则在 dock/control-bar 被 CSS 隐藏的瞬间，applyReal2dStageLayout 会读到
 * controlBar.top = 0，把整窗口高度作为 stage height，永久把 real2dStableStageHeight
 * 单调推升到工作区高度，从而把 avatar canvas resize 得过大。
 */
export function shouldFreezeReal2dStageLayoutForH5(state: {
  h5AppletOpen: boolean
  pendingH5AppletCloseWindowSize: WindowSize | null
}): boolean {
  return state.h5AppletOpen || state.pendingH5AppletCloseWindowSize != null
}

export function shouldResetReal2dCompactScaleOnConfigClose(
  open: boolean,
  reason?: ConfigPanelCloseReason,
): boolean {
  if (open) return false
  return reason === undefined || reason === 'cancel' || reason === 'saved'
}

export function isWindowSizeRestored(
  current: WindowSize,
  target: WindowSize | null,
  tolerancePx = 4,
): boolean {
  if (!target) return true
  return (
    Math.abs(current.width - target.width) <= tolerancePx &&
    Math.abs(current.height - target.height) <= tolerancePx
  )
}
