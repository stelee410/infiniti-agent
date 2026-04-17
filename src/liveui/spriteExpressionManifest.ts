/**
 * Node 侧：磁盘读取 + 再导出核心（供 CLI、ChatApp、emotionParse）。
 * 浏览器打包请从 `spriteExpressionManifestCore.js` 引用。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { LiveUiConfig } from '../config/types.js'
import { parseSpriteExpressionManifest, type SpriteExpressionManifestV1 } from './spriteExpressionManifestCore.js'

export * from './spriteExpressionManifestCore.js'

/** 解析 manifest 路径：显式 manifest > spriteExpressions.dir/expressions.json */
export function resolveSpriteExpressionManifestPath(cwd: string, liveUi?: LiveUiConfig): string | null {
  const man = liveUi?.spriteExpressions?.manifest?.trim()
  if (man) return resolve(cwd, man)
  const dir = liveUi?.spriteExpressions?.dir?.trim()
  if (dir) {
    const p = join(resolve(cwd, dir), 'expressions.json')
    if (existsSync(p)) return p
  }
  return null
}

export function tryReadSpriteExpressionManifestSync(
  cwd: string,
  liveUi?: LiveUiConfig,
): SpriteExpressionManifestV1 | null {
  const p = resolveSpriteExpressionManifestPath(cwd, liveUi)
  if (!p || !existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown
    return parseSpriteExpressionManifest(raw)
  } catch {
    return null
  }
}
