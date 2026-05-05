import type { WindowSize } from './panelLayoutPolicy.ts'

export type LayoutFrameHost = {
  requestAnimationFrame(callback: FrameRequestCallback): number
  setTimeout(callback: () => void, timeout?: number): number
  clearTimeout(id: number): void
}

export type LiveUiLayoutCoordinatorOptions = {
  host?: LayoutFrameHost
  isDynamicFitAllowed(): boolean
  isMinimalMode(): boolean
  syncMinimalWindowBounds(): void
  runCompactWindowFit(attempt: number): void
  runNormalLayout(attempt: number): void
  getWindowSize(): WindowSize
  isWindowSizeRestored(current: WindowSize, target: WindowSize | null): boolean
}

export type RefreshAfterRestoreOptions = {
  getTarget(): WindowSize | null
  clearTarget(): void
  beforeRefresh?(): void
}

export type LiveUiLayoutCoordinator = {
  cancelDynamicFit(): void
  scheduleDynamicFit(attempt?: number): void
  refreshNormal(attempt?: number): void
  refreshAfterWindowRestore(options: RefreshAfterRestoreOptions, attempt?: number): void
}

function frame(host: LayoutFrameHost, callback: () => void): void {
  host.requestAnimationFrame(() => callback())
}

export function createLiveUiLayoutCoordinator(
  options: LiveUiLayoutCoordinatorOptions,
): LiveUiLayoutCoordinator {
  const host = options.host ?? window
  let dynamicFitTimer: number | undefined

  const cancelDynamicFit = (): void => {
    if (dynamicFitTimer !== undefined) {
      host.clearTimeout(dynamicFitTimer)
      dynamicFitTimer = undefined
    }
  }

  const scheduleDynamicFit = (attempt = 0): void => {
    if (!options.isDynamicFitAllowed()) return
    cancelDynamicFit()
    dynamicFitTimer = host.setTimeout(() => {
      dynamicFitTimer = undefined
      if (!options.isDynamicFitAllowed()) return
      if (options.isMinimalMode()) {
        options.syncMinimalWindowBounds()
      } else {
        options.runCompactWindowFit(attempt)
      }
    }, 0)
  }

  const refreshNormal = (attempt = 0): void => {
    frame(host, () => {
      options.runNormalLayout(attempt)
      if (attempt < 4) {
        host.setTimeout(() => refreshNormal(attempt + 1), 90)
      }
    })
  }

  const refreshAfterWindowRestore = (
    refreshOptions: RefreshAfterRestoreOptions,
    attempt = 0,
  ): void => {
    frame(host, () => {
      const target = refreshOptions.getTarget()
      if (!options.isWindowSizeRestored(options.getWindowSize(), target) && attempt < 20) {
        host.setTimeout(() => refreshAfterWindowRestore(refreshOptions, attempt + 1), 50)
        return
      }
      refreshOptions.clearTarget()
      refreshOptions.beforeRefresh?.()
      refreshNormal()
    })
  }

  return {
    cancelDynamicFit,
    scheduleDynamicFit,
    refreshNormal,
    refreshAfterWindowRestore,
  }
}
