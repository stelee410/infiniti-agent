import { FIGURE_LAYOUT } from './figureLayoutConfig.ts'

export type FigureLayoutPlan = {
  platformTop: number
  soleCeiling: number
  targetFootY: number
  footNudgeMax: number
  scaleVerticalBudget: number
  figureZoom: number
}

export type FigureLayoutInput = {
  viewportWidth: number
  viewportHeight: number
  canvasTop: number
  dockTop?: number | null
  controlBarTop?: number | null
  figureZoom?: number
}

export function clampFigureZoom(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 1
  return Math.max(0.4, Math.min(1.5, raw))
}

export function computeFigureLayoutPlan(input: FigureLayoutInput): FigureLayoutPlan {
  const H = input.viewportHeight
  const gap = Math.max(0, Math.round(H * FIGURE_LAYOUT.footGapScreenFraction))
  const minPlatformTop = Math.round(H * FIGURE_LAYOUT.minPlatformTopScreenFraction)
  const fallbackPlatform =
    typeof input.dockTop === 'number' && Number.isFinite(input.dockTop)
      ? input.dockTop - input.canvasTop
      : Math.max(120, H - Math.ceil(H * FIGURE_LAYOUT.fallbackDockReserveScreenFraction))
  const rawPlatform =
    typeof input.controlBarTop === 'number' && Number.isFinite(input.controlBarTop)
      ? input.controlBarTop - input.canvasTop
      : fallbackPlatform
  const platformTop = Math.max(rawPlatform, minPlatformTop)
  const footNudgeMax = Math.min(
    FIGURE_LAYOUT.footNudgeMaxPx,
    Math.round(H * FIGURE_LAYOUT.footNudgeScreenFraction),
  )

  return {
    platformTop,
    soleCeiling: platformTop - FIGURE_LAYOUT.footClearOfControlBarPx,
    targetFootY: platformTop + FIGURE_LAYOUT.footStandOnOverlapPx - gap,
    footNudgeMax,
    scaleVerticalBudget: Math.max(
      100,
      Math.round(H * FIGURE_LAYOUT.modelScaleViewportHeightFraction),
    ),
    figureZoom: clampFigureZoom(input.figureZoom),
  }
}

export function computeFigureScale(plan: FigureLayoutPlan, viewportWidth: number, naturalW: number, naturalH: number): number {
  const uw = Math.max(naturalW, 1)
  const uh = Math.max(naturalH, 1)
  const sBase = Math.min(
    (viewportWidth * FIGURE_LAYOUT.modelWidthScreenFraction) / uw,
    (plan.scaleVerticalBudget * FIGURE_LAYOUT.modelHeightScaleFraction) / uh,
  )
  return sBase * plan.figureZoom
}
