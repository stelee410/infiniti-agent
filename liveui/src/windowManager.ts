export type LiveUiWindowBounds = { width: number; height: number }

export type LiveUiWindowBridge = {
  setIgnoreMouseEvents?: (ignore: boolean, opts?: { forward?: boolean }) => void
  compactWindowHeight?: (height: number) => void
  setConfigPanelOpen?: (open: boolean) => void
  setInboxOpen?: (open: boolean) => void
  setCameraCaptureOpen?: (open: boolean) => void
  setMinimalModeOpen?: (open: boolean, bounds?: LiveUiWindowBounds) => void
}

export type LiveUiWindowManager = {
  compactHeight(height: number): void
  setConfigPanelOpen(open: boolean): void
  setInboxOpen(open: boolean): void
  setCameraCaptureOpen(open: boolean): void
  setMinimalModeOpen(open: boolean, bounds?: LiveUiWindowBounds): void
  setInteractive(interactive: boolean): void
}

export function createLiveUiWindowManager(bridge?: LiveUiWindowBridge): LiveUiWindowManager {
  const setInteractive = (interactive: boolean): void => {
    bridge?.setIgnoreMouseEvents?.(!interactive, { forward: true })
  }

  return {
    compactHeight(height) {
      bridge?.compactWindowHeight?.(height)
    },
    setConfigPanelOpen(open) {
      bridge?.setConfigPanelOpen?.(open)
      setInteractive(open)
    },
    setInboxOpen(open) {
      if (bridge?.setInboxOpen) {
        bridge.setInboxOpen(open)
      } else {
        setInteractive(open)
      }
    },
    setCameraCaptureOpen(open) {
      bridge?.setCameraCaptureOpen?.(open)
    },
    setMinimalModeOpen(open, bounds) {
      bridge?.setMinimalModeOpen?.(open, bounds)
    },
    setInteractive,
  }
}
