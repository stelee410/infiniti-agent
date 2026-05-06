import type { InfinitiConfig } from '../config/types.js'
import {
  resolveAvatarFallbackForUi,
  resolveLive2dModelForUi,
  resolveSpriteExpressionDirForUi,
  type ResolvedAvatarFallback,
  type ResolvedLive2dModel,
  type ResolvedSpriteExpressionDir,
} from '../liveui/resolveModelPath.js'
import { buildLiveUiVoiceMicEnvJson } from '../liveui/voiceMicEnv.js'

export type LiveCommandOptions = {
  port?: string
  zoom?: string
  auto?: boolean
}

export type LiveCommandPlan = {
  port: number
  renderer: 'live2d' | 'sprite' | 'real2d'
  model3FileUrl?: string
  spriteExpressionDirFileUrl?: string
  avatarFallbackFileUrl?: string
  voiceMicJson: string
  figureZoomOverride?: number
  warnings: string[]
  info: string[]
}

export type LiveCommandDeps = {
  envPort?: string
  resolveSpriteExpressionDirForUi: (cwd: string, liveUi: InfinitiConfig['liveUi']) => ResolvedSpriteExpressionDir | null
  resolveLive2dModelForUi: (cwd: string, liveUi: InfinitiConfig['liveUi']) => ResolvedLive2dModel | null
  resolveAvatarFallbackForUi: (cwd: string) => ResolvedAvatarFallback | null
  buildLiveUiVoiceMicEnvJson: (liveUi: InfinitiConfig['liveUi'], opts: { auto?: boolean }) => string
}

export class LiveCommandError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LiveCommandError'
  }
}

export function defaultLiveCommandDeps(): LiveCommandDeps {
  return {
    envPort: process.env.INFINITI_LIVEUI_PORT,
    resolveSpriteExpressionDirForUi,
    resolveLive2dModelForUi,
    resolveAvatarFallbackForUi,
    buildLiveUiVoiceMicEnvJson,
  }
}

export function resolveLiveCommandPlan(
  cwd: string,
  cfg: InfinitiConfig,
  opts: LiveCommandOptions,
  deps: LiveCommandDeps = defaultLiveCommandDeps(),
): LiveCommandPlan {
  const port = parseLivePort(opts.port, cfg.liveUi?.port, deps.envPort)
  const spriteResolved = deps.resolveSpriteExpressionDirForUi(cwd, cfg.liveUi)
  const live2dResolved = deps.resolveLive2dModelForUi(cwd, cfg.liveUi)
  const avatarFallback = deps.resolveAvatarFallbackForUi(cwd)
  const warnings = [
    ...(spriteResolved?.warnings ?? []),
    ...(live2dResolved?.warnings ?? []),
  ]

  const useSprite = Boolean(spriteResolved?.dirFileUrl)
  const configuredRenderer = cfg.liveUi?.renderer ?? (useSprite ? 'sprite' : 'live2d')
  const useReal2d = configuredRenderer === 'real2d' && useSprite
  const useSpriteOnly = configuredRenderer === 'sprite' && useSprite
  const info: string[] = []
  if (configuredRenderer === 'real2d' && !useSprite) {
    warnings.push('renderer=real2d 需要 liveUi.spriteExpressions.dir，当前将回退 Live2D/占位')
  } else if (useReal2d) {
    info.push('已启用 real2d（基于 spriteExpressions PNG），不使用 Live2D 模型 URL')
  } else if (useSpriteOnly) {
    info.push('已启用 spriteExpressions（PNG），不使用 Live2D 模型 URL')
  }
  if (!useSprite && avatarFallback?.avatarFileUrl) {
    info.push('spriteExpressions 不可用，已启用圆形头像兜底')
  }

  const figureZoomOverride = parseLiveZoomOverride(opts.zoom)
  if (figureZoomOverride !== undefined) {
    info.push(`人物缩放: ${(figureZoomOverride * 100).toFixed(0)}%`)
  } else if (typeof cfg.liveUi?.figureZoom === 'number') {
    info.push(`人物缩放: ${(cfg.liveUi.figureZoom * 100).toFixed(0)}%`)
  }

  return {
    port,
    renderer: useReal2d ? 'real2d' : useSpriteOnly ? 'sprite' : 'live2d',
    model3FileUrl: useReal2d || useSpriteOnly ? undefined : live2dResolved?.model3FileUrl,
    spriteExpressionDirFileUrl: useReal2d || useSpriteOnly ? spriteResolved?.dirFileUrl : undefined,
    avatarFallbackFileUrl: !useSprite ? avatarFallback?.avatarFileUrl : undefined,
    voiceMicJson: deps.buildLiveUiVoiceMicEnvJson(cfg.liveUi, { auto: opts.auto === true }),
    figureZoomOverride,
    warnings,
    info,
  }
}

export function parseLivePort(
  explicitPort: string | undefined,
  configPort: number | undefined,
  envPort: string | undefined,
): number {
  const raw = explicitPort?.trim()
  const port = raw
    ? Number(raw)
    : configPort ?? (envPort ? Number(envPort) : 8080)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new LiveCommandError('无效端口，请使用 1–65535 之间的数字。')
  }
  return port
}

export function parseLiveZoomOverride(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined
  const z = Number(trimmed)
  if (!Number.isFinite(z) || z < 0.4 || z > 1.5) {
    throw new LiveCommandError('[live] --zoom 取值需在 0.4 ~ 1.5 之间，例如 0.9 表示 90%。')
  }
  return z
}
