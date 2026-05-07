import { describe, expect, it, vi } from 'vitest'
import { createLiveUiWindowManager } from './windowManager.ts'

describe('createLiveUiWindowManager', () => {
  it('routes compact avatar layout through a single layout request', () => {
    const compactWindowHeight = vi.fn()
    const manager = createLiveUiWindowManager({ compactWindowHeight })

    manager.requestLayout({ mode: 'avatar', reason: 'assistant-bubble-fit', compactHeight: 512 })

    expect(compactWindowHeight).toHaveBeenCalledWith(512)
  })

  it('routes minimal bounds through the layout request API', () => {
    const setMinimalModeOpen = vi.fn()
    const manager = createLiveUiWindowManager({ setMinimalModeOpen })

    manager.requestLayout({
      mode: 'minimal',
      reason: 'minimal-content-fit',
      open: true,
      bounds: { width: 360, height: 120 },
    })

    expect(setMinimalModeOpen).toHaveBeenCalledWith(true, { width: 360, height: 120 })
  })

  it('makes config layout requests interactive while the panel is open', () => {
    const setConfigPanelOpen = vi.fn()
    const setIgnoreMouseEvents = vi.fn()
    const manager = createLiveUiWindowManager({ setConfigPanelOpen, setIgnoreMouseEvents })

    manager.requestLayout({ mode: 'config', reason: 'config-panel', open: true })
    manager.requestLayout({ mode: 'config', reason: 'config-panel', open: false })

    expect(setConfigPanelOpen).toHaveBeenNthCalledWith(1, true)
    expect(setConfigPanelOpen).toHaveBeenNthCalledWith(2, false)
    expect(setIgnoreMouseEvents).toHaveBeenNthCalledWith(1, false, { forward: true })
    expect(setIgnoreMouseEvents).toHaveBeenNthCalledWith(2, true, { forward: true })
  })

  it('uses the dedicated inbox window channel when available', () => {
    const setInboxOpen = vi.fn()
    const setConfigPanelOpen = vi.fn()
    const setIgnoreMouseEvents = vi.fn()
    const manager = createLiveUiWindowManager({
      setInboxOpen,
      setConfigPanelOpen,
      setIgnoreMouseEvents,
    })

    manager.setInboxOpen(true)

    expect(setInboxOpen).toHaveBeenCalledWith(true)
    expect(setConfigPanelOpen).not.toHaveBeenCalled()
    expect(setIgnoreMouseEvents).not.toHaveBeenCalled()
  })

  it('routes H5 applet layout through the shared window manager', () => {
    const setH5AppletOpen = vi.fn()
    const setIgnoreMouseEvents = vi.fn()
    const manager = createLiveUiWindowManager({ setH5AppletOpen, setIgnoreMouseEvents })

    manager.requestLayout({ mode: 'h5Applet', reason: 'show-me-magic', open: true })
    manager.setH5AppletOpen(false)

    expect(setH5AppletOpen).toHaveBeenNthCalledWith(1, true)
    expect(setH5AppletOpen).toHaveBeenNthCalledWith(2, false)
    expect(setIgnoreMouseEvents).not.toHaveBeenCalled()
  })

  it('falls back to mouse interactivity for H5 applets without a bridge channel', () => {
    const setIgnoreMouseEvents = vi.fn()
    const manager = createLiveUiWindowManager({ setIgnoreMouseEvents })

    manager.setH5AppletOpen(true)
    manager.setH5AppletOpen(false)

    expect(setIgnoreMouseEvents).toHaveBeenNthCalledWith(1, false, { forward: true })
    expect(setIgnoreMouseEvents).toHaveBeenNthCalledWith(2, true, { forward: true })
  })

  it('falls back to mouse interactivity for inbox overlays without a bridge channel', () => {
    const setIgnoreMouseEvents = vi.fn()
    const manager = createLiveUiWindowManager({ setIgnoreMouseEvents })

    manager.setInboxOpen(true)
    manager.setInboxOpen(false)

    expect(setIgnoreMouseEvents).toHaveBeenNthCalledWith(1, false, { forward: true })
    expect(setIgnoreMouseEvents).toHaveBeenNthCalledWith(2, true, { forward: true })
  })
})
