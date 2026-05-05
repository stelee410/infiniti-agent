import { describe, expect, it, vi } from 'vitest'
import { createLiveUiLayoutCoordinator, type LayoutFrameHost } from './layoutCoordinator.ts'

function immediateHost(): LayoutFrameHost {
  return {
    requestAnimationFrame: (cb) => {
      cb(0)
      return 1
    },
    setTimeout: (cb) => {
      cb()
      return 1
    },
    clearTimeout: vi.fn(),
  }
}

describe('createLiveUiLayoutCoordinator', () => {
  it('runs compact fitting for normal avatar layout', () => {
    const compact = vi.fn()
    const coordinator = createLiveUiLayoutCoordinator({
      host: immediateHost(),
      isDynamicFitAllowed: () => true,
      isMinimalMode: () => false,
      syncMinimalWindowBounds: vi.fn(),
      runCompactWindowFit: compact,
      runNormalLayout: vi.fn(),
      getWindowSize: () => ({ width: 420, height: 580 }),
      isWindowSizeRestored: () => true,
    })

    coordinator.scheduleDynamicFit(2)

    expect(compact).toHaveBeenCalledWith(2)
  })

  it('syncs minimal bounds instead of compacting in minimal mode', () => {
    const compact = vi.fn()
    const syncMinimal = vi.fn()
    const coordinator = createLiveUiLayoutCoordinator({
      host: immediateHost(),
      isDynamicFitAllowed: () => true,
      isMinimalMode: () => true,
      syncMinimalWindowBounds: syncMinimal,
      runCompactWindowFit: compact,
      runNormalLayout: vi.fn(),
      getWindowSize: () => ({ width: 420, height: 580 }),
      isWindowSizeRestored: () => true,
    })

    coordinator.scheduleDynamicFit()

    expect(syncMinimal).toHaveBeenCalledOnce()
    expect(compact).not.toHaveBeenCalled()
  })

  it('does not run dynamic fitting while layout is suspended', () => {
    const compact = vi.fn()
    const coordinator = createLiveUiLayoutCoordinator({
      host: immediateHost(),
      isDynamicFitAllowed: () => false,
      isMinimalMode: () => false,
      syncMinimalWindowBounds: vi.fn(),
      runCompactWindowFit: compact,
      runNormalLayout: vi.fn(),
      getWindowSize: () => ({ width: 420, height: 580 }),
      isWindowSizeRestored: () => true,
    })

    coordinator.scheduleDynamicFit()

    expect(compact).not.toHaveBeenCalled()
  })

  it('waits for a restored window size before refreshing normal layout', () => {
    const runNormal = vi.fn()
    let current = { width: 860, height: 720 }
    const coordinator = createLiveUiLayoutCoordinator({
      host: immediateHost(),
      isDynamicFitAllowed: () => true,
      isMinimalMode: () => false,
      syncMinimalWindowBounds: vi.fn(),
      runCompactWindowFit: vi.fn(),
      runNormalLayout: runNormal,
      getWindowSize: () => current,
      isWindowSizeRestored: (value, target) => {
        const restored = value.width === target?.width && value.height === target.height
        current = { width: 420, height: 580 }
        return restored
      },
    })

    coordinator.refreshAfterWindowRestore({
      getTarget: () => ({ width: 420, height: 580 }),
      clearTarget: vi.fn(),
    })

    expect(runNormal).toHaveBeenCalled()
  })
})
