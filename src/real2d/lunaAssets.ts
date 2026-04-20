import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PACKAGE_ROOT } from '../packageRoot.js'

/** 仓库内写实/精灵表情素材目录（与 Live2D 模型并列） */
export const LUNA_EXPRESSION_DIR = join(PACKAGE_ROOT, 'live2d-models', 'luna', 'expression')

const EXP_RE = /^exp_\d+\.png$/i

export function listLunaExpressionPngs(): string[] {
  if (!existsSync(LUNA_EXPRESSION_DIR)) return []
  return readdirSync(LUNA_EXPRESSION_DIR)
    .filter((f) => EXP_RE.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

export function assertLunaAssetsPresent(): { ok: boolean; files: string[]; dir: string; error?: string } {
  const dir = LUNA_EXPRESSION_DIR
  if (!existsSync(dir)) {
    return { ok: false, files: [], dir, error: `目录不存在: ${dir}` }
  }
  const files = listLunaExpressionPngs()
  if (files.length === 0) {
    return { ok: false, files: [], dir, error: `未找到 exp_*.png: ${dir}` }
  }
  return { ok: true, files, dir }
}
