import { describe, expect, it } from 'vitest'
import {
  clampFigureZoom,
  computeFigureLayoutPlan,
  computeFigureScale,
  computeReal2dCompactScaleCompensation,
  computeReal2dRuntimeStageHeight,
  computeReal2dStageHeight,
} from './figureManager.ts'

describe('figureManager', () => {
  it('clamps user figure zoom to the supported avatar range', () => {
    expect(clampFigureZoom(undefined)).toBe(1)
    expect(clampFigureZoom(0.1)).toBe(0.4)
    expect(clampFigureZoom(2)).toBe(1.5)
    expect(clampFigureZoom(1.2)).toBe(1.2)
  })

  it('computes a stable platform from control bar measurements', () => {
    const plan = computeFigureLayoutPlan({
      viewportWidth: 420,
      viewportHeight: 580,
      canvasTop: 0,
      dockTop: 440,
      controlBarTop: 460,
      figureZoom: 1,
    })

    expect(plan.platformTop).toBe(460)
    expect(plan.targetFootY).toBe(464)
    expect(plan.soleCeiling).toBe(460)
  })

  it('keeps scale independent from dock height changes', () => {
    const shortDock = computeFigureLayoutPlan({
      viewportWidth: 420,
      viewportHeight: 580,
      canvasTop: 0,
      dockTop: 500,
      controlBarTop: 500,
      figureZoom: 1,
    })
    const tallDock = computeFigureLayoutPlan({
      viewportWidth: 420,
      viewportHeight: 580,
      canvasTop: 0,
      dockTop: 380,
      controlBarTop: 380,
      figureZoom: 1,
    })

    expect(computeFigureScale(shortDock, 420, 400, 600)).toBe(
      computeFigureScale(tallDock, 420, 400, 600),
    )
  })

  it('computes Real2D stage height from the control bar top', () => {
    expect(computeReal2dStageHeight(580, 420.8)).toBe(420)
    expect(computeReal2dStageHeight(580, 120)).toBe(260)
    expect(computeReal2dStageHeight(580, undefined)).toBe(580)
  })

  it('keeps Real2D runtime stage height stable outside minimal mode', () => {
    expect(computeReal2dRuntimeStageHeight({
      currentStageHeight: 420,
      stableStageHeight: 500,
      minimalMode: false,
    })).toEqual({
      runtimeStageHeight: 500,
      stableStageHeight: 500,
    })
    expect(computeReal2dRuntimeStageHeight({
      currentStageHeight: 540,
      stableStageHeight: 500,
      minimalMode: false,
    })).toEqual({
      runtimeStageHeight: 540,
      stableStageHeight: 540,
    })
  })

  it('clamps Real2D compact scale compensation', () => {
    expect(computeReal2dCompactScaleCompensation(500, 400)).toBe(1.25)
    expect(computeReal2dCompactScaleCompensation(1000, 400)).toBe(1.6)
    expect(computeReal2dCompactScaleCompensation(100, 400)).toBe(0.7)
  })
})
