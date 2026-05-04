import { describe, expect, it } from 'vitest'
import {
  clampFigureZoom,
  computeFigureLayoutPlan,
  computeFigureScale,
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
})
