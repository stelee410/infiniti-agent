export type ConfigPanelLayoutAction = 'suspend-fit' | 'refresh-normal-layout'
export type ConfigPanelCloseReason = 'cancel' | 'saved'

export function configPanelLayoutAction(open: boolean): ConfigPanelLayoutAction {
  return open ? 'suspend-fit' : 'refresh-normal-layout'
}

export function shouldRunDynamicFigureFit(state: {
  minimalMode: boolean
  configPanelOpen: boolean
}): boolean {
  return state.minimalMode || !state.configPanelOpen
}

export function shouldResetReal2dCompactScaleOnConfigClose(
  open: boolean,
  reason?: ConfigPanelCloseReason,
): boolean {
  if (open) return false
  return reason === undefined || reason === 'cancel' || reason === 'saved'
}
