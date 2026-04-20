/**
 * 把 exp_speaking_{e,i,o,u}.png 与 exp_calm.png 对齐到相同画布尺寸 / 主体居中位置。
 *
 * 思路：
 *   1) 取 exp_calm 的画布尺寸 (W,H) 与 主体外接框中心 (cxC, cyC)。
 *   2) 对每张较小的 PNG，检测主体外接框中心 (cxS, cyS)。
 *   3) 用 studio 灰扩边到 (W,H)，使 originX = cxC - cxS、originY = cyC - cyS。
 *      同色背景在后续 transparentize 步骤里会被一起抠成透明。
 *
 * 用法（仓库根目录）：
 *   npx tsx scripts/jess-align-vowel-pngs.ts
 *
 * 默认就地覆盖；加 --dry-run 只打印分析结果。
 */
import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

type Bbox = { x0: number; y0: number; x1: number; y1: number; cx: number; cy: number }

const STUDIO_GRAY: [number, number, number] = [217, 217, 217]
const TARGETS = [
  'exp_speaking_e.png',
  'exp_speaking_i.png',
  'exp_speaking_o.png',
  'exp_speaking_u.png',
]
const REFERENCE = 'exp_calm.png'

function isSubjectPixel(r: number, g: number, b: number): boolean {
  /** 非中性 / 非白 / 非接近 STUDIO_GRAY 视为主体 */
  const minC = Math.min(r, g, b)
  const maxC = Math.max(r, g, b)
  const sat = maxC - minC
  if (sat > 22) return true
  const lum = 0.299 * r + 0.587 * g + 0.114 * b
  if (lum < 165) return true
  const dr = r - STUDIO_GRAY[0]
  const dg = g - STUDIO_GRAY[1]
  const db = b - STUDIO_GRAY[2]
  if (Math.abs(dr) > 14 || Math.abs(dg) > 14 || Math.abs(db) > 14) {
    if (lum < 235) return true
  }
  return false
}

async function detectSubjectBbox(path: string): Promise<{ w: number; h: number; bbox: Bbox }> {
  const img = sharp(path).ensureAlpha().raw()
  const { data, info } = await img.toBuffer({ resolveWithObject: true })
  const { width: w, height: h, channels } = info
  if (channels !== 4) throw new Error(`unexpected channels=${channels} for ${path}`)

  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1

  /** 边缘 12px 一律视为背景，避免 chroma key 等噪点污染外接框 */
  const margin = 12
  for (let y = margin; y < h - margin; y++) {
    for (let x = margin; x < w - margin; x++) {
      const i = (y * w + x) * 4
      const r = data[i]!
      const g = data[i + 1]!
      const b = data[i + 2]!
      if (!isSubjectPixel(r, g, b)) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }

  if (x1 < 0) {
    return {
      w,
      h,
      bbox: { x0: 0, y0: 0, x1: w - 1, y1: h - 1, cx: w / 2, cy: h / 2 },
    }
  }
  return {
    w,
    h,
    bbox: { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 },
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const root = join(__dirname, '..')
  const dir = join(root, 'live2d-models', 'jess', 'expression')

  const refPath = join(dir, REFERENCE)
  const ref = await detectSubjectBbox(refPath)
  console.error(
    `REF ${REFERENCE}: ${ref.w}x${ref.h}  bbox=(${ref.bbox.x0},${ref.bbox.y0})-(${ref.bbox.x1},${ref.bbox.y1})  center=(${ref.bbox.cx.toFixed(1)},${ref.bbox.cy.toFixed(1)})`,
  )

  for (const fname of TARGETS) {
    const p = join(dir, fname)
    let info: { w: number; h: number; bbox: Bbox }
    try {
      info = await detectSubjectBbox(p)
    } catch (e) {
      console.error(`SKIP ${fname}: ${(e as Error).message}`)
      continue
    }
    if (info.w === ref.w && info.h === ref.h) {
      console.error(`OK   ${fname}: 已与 ${REFERENCE} 同尺寸，跳过`)
      continue
    }

    const desiredOriginX = Math.round(ref.bbox.cx - info.bbox.cx)
    const desiredOriginY = Math.round(ref.bbox.cy - info.bbox.cy)
    const left = Math.max(0, Math.min(ref.w - info.w, desiredOriginX))
    const top = Math.max(0, Math.min(ref.h - info.h, desiredOriginY))
    const right = ref.w - info.w - left
    const bottom = ref.h - info.h - top

    console.error(
      `PAD  ${fname}: ${info.w}x${info.h} → ${ref.w}x${ref.h}  bboxC=(${info.bbox.cx.toFixed(1)},${info.bbox.cy.toFixed(1)})  origin=(${left},${top})  pad L${left} R${right} T${top} B${bottom}`,
    )

    if (dryRun) continue

    const padded = await sharp(p)
      .extend({
        top,
        bottom,
        left,
        right,
        background: { r: STUDIO_GRAY[0], g: STUDIO_GRAY[1], b: STUDIO_GRAY[2], alpha: 1 },
      })
      .png()
      .toBuffer()

    await copyFile(p, p + '.bak')
    await writeFile(p, padded)
    console.error(`     → 写回 ${fname}（备份 ${fname}.bak）`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
