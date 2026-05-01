export type ConfigPanelLayoutAction = 'suspend-fit' | 'refresh-normal-layout'
export type ConfigPanelCloseReason = 'cancel' | 'saved'
export type WindowSize = { width: number; height: number }

export function configPanelLayoutAction(open: boolean): ConfigPanelLayoutAction {
  return open ? 'suspend-fit' : 'refresh-normal-layout'
}

export function shouldRunDynamicFigureFit(state: {
  minimalMode: boolean
  configPanelOpen: boolean
}): boolean {
  return state.minimalMode || !state.configPanelOpen
}

export function shouldApplyReal2dResizeLayout(state: {
  configPanelOpen: boolean
  pendingConfigPanelCloseRestore: boolean
  closeWindowRestored: boolean
}): boolean {
  if (state.configPanelOpen) return false
  if (state.pendingConfigPanelCloseRestore) return state.closeWindowRestored
  return true
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
