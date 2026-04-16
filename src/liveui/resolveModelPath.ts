import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { LiveUiConfig } from '../config/types.js'
import { expandUserPath } from '../paths.js'

type ModelDictEntry = {
  name?: string
  url?: string
}

function readModelDict(dictPath: string): ModelDictEntry[] {
  const raw = readFileSync(dictPath, 'utf8')
  const j = JSON.parse(raw) as unknown
  if (!Array.isArray(j)) return []
  return j as ModelDictEntry[]
}

/**
 * 将 Open-LLM-VTuber 风格 `url`（如 `/live2d-models/mao_pro/runtime/mao_pro.model3.json`）
 * 解析为本地绝对路径。
 *
 * - 若配置了 `live2dModelsDir` 且 `url` 以 `live2d-models/` 开头：用该目录替换路径前缀中的第一段。
 * - 否则：`url` 去掉前导 `/` 后相对 **cwd** 拼接（与仓库根目录下放 `live2d-models` 的布局一致）。
 */
export function resolveModelDictUrlToFilesystem(
  cwd: string,
  modelsDir: string | undefined,
  url: string,
): string {
  const trimmed = url.trim().replace(/^\/+/, '')
  const parts = trimmed.split('/').filter(Boolean)
  if (parts.length === 0) {
    throw new Error('model_dict 条目的 url 为空')
  }

  if (modelsDir?.trim()) {
    const absRoot = normalize(resolve(cwd, expandUserPath(modelsDir.trim())))
    if (parts[0] === 'live2d-models' && parts.length > 1) {
      return normalize(join(absRoot, ...parts.slice(1)))
    }
    return normalize(join(absRoot, ...parts))
  }

  return normalize(resolve(cwd, ...parts))
}

export type ResolvedLive2dModel = {
  /** 本地 .model3.json 绝对路径 */
  model3JsonPath: string
  /** 供渲染进程 fetch / Live2D 加载使用的 file: URL */
  model3FileUrl: string
  /** 非致命提示（如文件尚不存在） */
  warnings: string[]
}

/** `spriteExpressions.dir` 解析为带尾斜杠的 `file:` URL，供渲染端 `new URL('exp_01.png', base)` 拼接 */
export type ResolvedSpriteExpressionDir = {
  dirFileUrl: string
  warnings: string[]
}

/**
 * 解析 `liveUi.spriteExpressions.dir`（相对 cwd），供 Electron 注入 `INFINITI_LIVEUI_SPRITE_EXPRESSION_DIR`。
 */
export function resolveSpriteExpressionDirForUi(
  cwd: string,
  liveUi?: LiveUiConfig,
): ResolvedSpriteExpressionDir | null {
  const warnings: string[] = []
  const raw = liveUi?.spriteExpressions?.dir?.trim()
  if (!raw) return null

  const abs = normalize(resolve(cwd, expandUserPath(raw)))
  if (!existsSync(abs)) {
    warnings.push(`spriteExpressions.dir 路径不存在: ${abs}`)
    return null
  }
  if (!statSync(abs).isDirectory()) {
    warnings.push(`spriteExpressions.dir 不是目录: ${abs}`)
    return null
  }

  const href = pathToFileURL(abs).href
  const dirFileUrl = href.endsWith('/') ? href : `${href}/`
  return { dirFileUrl, warnings }
}

/**
 * 根据 `config.json` 的 `liveUi` 块解析离线 Live2D 模型入口文件。
 */
export function resolveLive2dModelForUi(cwd: string, liveUi?: LiveUiConfig): ResolvedLive2dModel | null {
  const warnings: string[] = []
  if (!liveUi) {
    return null
  }

  const direct = liveUi.live2dModel3Json?.trim()
  if (direct) {
    const expanded = expandUserPath(direct)
    const abs = normalize(isAbsolute(expanded) ? expanded : resolve(cwd, expanded))
    if (!existsSync(abs)) {
      warnings.push(`live2dModel3Json 路径不存在: ${abs}`)
    }
    return {
      model3JsonPath: abs,
      model3FileUrl: pathToFileURL(abs).href,
      warnings,
    }
  }

  const name = liveUi.live2dModelName?.trim()
  if (!name) {
    warnings.push('未设置 live2dModel3Json 或 live2dModelName，跳过模型路径解析')
    return null
  }

  const dictRel = liveUi.live2dModelDict?.trim() || 'model_dict.json'
  const dictPath = normalize(resolve(cwd, expandUserPath(dictRel)))
  if (!existsSync(dictPath)) {
    warnings.push(`live2dModelDict 文件不存在: ${dictPath}`)
    return null
  }

  let entries: ModelDictEntry[]
  try {
    entries = readModelDict(dictPath)
  } catch (e) {
    warnings.push(`读取 model_dict 失败: ${(e as Error).message}`)
    return null
  }

  const entry = entries.find((e) => e.name === name)
  if (!entry?.url?.trim()) {
    warnings.push(`model_dict 中未找到 name="${name}" 或缺少 url 字段`)
    return null
  }

  let abs: string
  try {
    abs = resolveModelDictUrlToFilesystem(cwd, liveUi.live2dModelsDir, entry.url.trim())
  } catch (e) {
    warnings.push((e as Error).message)
    return null
  }

  if (!abs.endsWith('.model3.json')) {
    warnings.push(`解析结果不是 .model3.json：${abs}`)
  }
  if (!existsSync(abs)) {
    warnings.push(`解析得到的模型文件不存在: ${abs}（相对项目: ${relative(cwd, abs) || '.'}）`)
  }

  return {
    model3JsonPath: abs,
    model3FileUrl: pathToFileURL(abs).href,
    warnings,
  }
}
