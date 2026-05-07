export type LiveUiWindowBounds = { width: number; height: number }
export type LiveUiWindowMode = 'avatar' | 'config' | 'inbox' | 'camera' | 'h5Applet' | 'minimal'
export type LiveUiWindowLayoutRequest =
  | { mode: 'avatar'; reason: string; compactHeight?: number }
  | { mode: 'config'; reason: string; open: boolean }
  | { mode: 'inbox'; reason: string; open: boolean }
  | { mode: 'camera'; reason: string; open: boolean }
  | { mode: 'h5Applet'; reason: string; open: boolean }
  | { mode: 'minimal'; reason: string; open: boolean; bounds?: LiveUiWindowBounds }

export type LiveUiWindowBridge = {
  setIgnoreMouseEvents?: (ignore: boolean, opts?: { forward?: boolean }) => void
  compactWindowHeight?: (height: number) => void
  setConfigPanelOpen?: (open: boolean) => void
  setInboxOpen?: (open: boolean) => void
  setCameraCaptureOpen?: (open: boolean) => void
  setH5AppletOpen?: (open: boolean) => void
  setMinimalModeOpen?: (open: boolean, bounds?: LiveUiWindowBounds) => void
}

export type LiveUiWindowManager = {
  requestLayout(request: LiveUiWindowLayoutRequest): void
  compactHeight(height: number): void
  setConfigPanelOpen(open: boolean): void
  setInboxOpen(open: boolean): void
  setCameraCaptureOpen(open: boolean): void
  setH5AppletOpen(open: boolean): void
  setMinimalModeOpen(open: boolean, bounds?: LiveUiWindowBounds): void
  setInteractive(interactive: boolean): void
}

export function createLiveUiWindowManager(bridge?: LiveUiWindowBridge): LiveUiWindowManager {
  const setInteractive = (interactive: boolean): void => {
    bridge?.setIgnoreMouseEvents?.(!interactive, { forward: true })
  }

  const requestLayout = (request: LiveUiWindowLayoutRequest): void => {
    switch (request.mode) {
      case 'avatar':
        if (typeof request.compactHeight === 'number' && Number.isFinite(request.compactHeight)) {
          bridge?.compactWindowHeight?.(request.compactHeight)
        }
        return
      case 'config':
        bridge?.setConfigPanelOpen?.(request.open)
        setInteractive(request.open)
        return
      case 'inbox':
        if (bridge?.setInboxOpen) {
          bridge.setInboxOpen(request.open)
        } else {
          setInteractive(request.open)
        }
        return
      case 'camera':
        bridge?.setCameraCaptureOpen?.(request.open)
        return
      case 'h5Applet':
        if (bridge?.setH5AppletOpen) {
          bridge.setH5AppletOpen(request.open)
        } else {
          setInteractive(request.open)
        }
        return
      case 'minimal':
        bridge?.setMinimalModeOpen?.(request.open, request.bounds)
        return
    }
  }

  return {
    requestLayout,
    compactHeight(height) {
      requestLayout({ mode: 'avatar', reason: 'compact-height', compactHeight: height })
    },
    setConfigPanelOpen(open) {
      requestLayout({ mode: 'config', reason: 'config-panel', open })
    },
    setInboxOpen(open) {
      requestLayout({ mode: 'inbox', reason: 'inbox-panel', open })
    },
    setCameraCaptureOpen(open) {
      requestLayout({ mode: 'camera', reason: 'camera-capture', open })
    },
    setH5AppletOpen(open) {
      requestLayout({ mode: 'h5Applet', reason: 'h5-applet', open })
    },
    setMinimalModeOpen(open, bounds) {
      requestLayout({ mode: 'minimal', reason: 'minimal-mode', open, bounds })
    },
    setInteractive,
  }
}
