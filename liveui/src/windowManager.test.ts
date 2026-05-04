import { describe, expect, it, vi } from 'vitest'
import { createLiveUiWindowManager } from './windowManager.ts'

describe('createLiveUiWindowManager', () => {
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

  it('falls back to mouse interactivity for inbox overlays without a bridge channel', () => {
    const setIgnoreMouseEvents = vi.fn()
    const manager = createLiveUiWindowManager({ setIgnoreMouseEvents })

    manager.setInboxOpen(true)
    manager.setInboxOpen(false)

    expect(setIgnoreMouseEvents).toHaveBeenNthCalledWith(1, false, { forward: true })
    expect(setIgnoreMouseEvents).toHaveBeenNthCalledWith(2, true, { forward: true })
  })
})
