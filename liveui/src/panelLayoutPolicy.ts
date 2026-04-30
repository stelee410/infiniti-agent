export type ConfigPanelLayoutAction = 'suspend-fit' | 'refresh-normal-layout'

export function configPanelLayoutAction(open: boolean): ConfigPanelLayoutAction {
  return open ? 'suspend-fit' : 'refresh-normal-layout'
}

export function shouldRunDynamicFigureFit(state: {
  minimalMode: boolean
  configPanelOpen: boolean
}): boolean {
  return state.minimalMode || !state.configPanelOpen
}
