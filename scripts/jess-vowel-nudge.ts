/**
 * 检测 exp_speaking_{a,e,i,o,u}.png 与 exp_calm.png 之间的「头部位置」像素偏移，
 * 写入 jess-mesh-lab/public/jess/vowel-nudge.json，供 main.ts 在切换贴图时按 vowel 微调 mesh 位置。
 *
 * 检测方法：取头发深色像素 (lum < 70) 的：
 *   1) 顶端 y0（最上 5% 深色像素的中位数 y）
 *   2) 这一带的中线 x（顶端附近行内深色像素 x 的中位数）
 * 以 calm 的 (cx, y0) 为基准，差值即为各元音相对偏移。
 *
 * 用法（仓库根目录）：
 *   npx tsx scripts/jess-vowel-nudge.ts
 *
 * 加 --print 仅打印不写文件。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const SRC_DIR_REL = ['live2d-models', 'jess', 'expression']
const OUT_REL = ['jess-mesh-lab', 'public', 'jess', 'vowel-nudge.json']
const REFERENCE = 'exp_calm.png'
const SLOTS = ['a', 'e', 'i', 'o', 'u'] as const
type Slot = (typeof SLOTS)[number]

type HairAnchor = { topY: number; topCx: number; w: number; h: number }

function isHairPixel(r: number, g: number, b: number): boolean {
  const lum = 0.299 * r + 0.587 * g + 0.114 * b
  return lum < 70
}

async function detectHair(path: string): Promise<HairAnchor> {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const w = info.width
  const h = info.height

  /** 仅在中央 60% 宽度寻找头部，避免裙摆/手等干扰 */
  const xMin = Math.floor(w * 0.2)
  const xMax = Math.floor(w * 0.8)
  /** 只看上半画幅 */
  const yMax = Math.floor(h * 0.55)

  const rowCounts = new Int32Array(h)
  for (let y = 0; y < yMax; y++) {
    let cnt = 0
    for (let x = xMin; x < xMax; x++) {
      const i = (y * w + x) * 4
      if (isHairPixel(data[i]!, data[i + 1]!, data[i + 2]!)) cnt++
    }
    rowCounts[y] = cnt
  }

  /** 第一段头发顶端：从上往下找首次每行 >= 阈值的 y */
  const widthSpan = xMax - xMin
  const thr = Math.max(8, Math.floor(widthSpan * 0.012))
  let topY = -1
  for (let y = 0; y < yMax; y++) {
    if (rowCounts[y]! >= thr) {
      topY = y
      break
    }
  }
  if (topY < 0) topY = 0

  /** 在头顶下方 4% 行内取深色像素 x 中位数作为头中线 */
  const sampleH = Math.max(8, Math.floor(h * 0.04))
  const xs: number[] = []
  for (let y = topY; y < Math.min(topY + sampleH, h); y++) {
    for (let x = xMin; x < xMax; x++) {
      const i = (y * w + x) * 4
      if (isHairPixel(data[i]!, data[i + 1]!, data[i + 2]!)) xs.push(x)
    }
  }
  let topCx = w / 2
  if (xs.length > 0) {
    xs.sort((a, b) => a - b)
    topCx = xs[Math.floor(xs.length / 2)]!
  }

  return { topY, topCx, w, h }
}

async function main(): Promise<void> {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const root = join(__dirname, '..')
  const srcDir = join(root, ...SRC_DIR_REL)
  const outPath = join(root, ...OUT_REL)
  const printOnly = process.argv.includes('--print')

  const refAnchor = await detectHair(join(srcDir, REFERENCE))
  console.error(
    `REF ${REFERENCE}: ${refAnchor.w}x${refAnchor.h}  topY=${refAnchor.topY}  topCx=${refAnchor.topCx}`,
  )

  const nudge: Record<Slot, { dx: number; dy: number }> = {
    a: { dx: 0, dy: 0 },
    e: { dx: 0, dy: 0 },
    i: { dx: 0, dy: 0 },
    o: { dx: 0, dy: 0 },
    u: { dx: 0, dy: 0 },
  }
  for (const slot of SLOTS) {
    const fname = `exp_speaking_${slot}.png`
    const a = await detectHair(join(srcDir, fname))
    const dx = refAnchor.topCx - a.topCx
    const dy = refAnchor.topY - a.topY
    nudge[slot] = { dx, dy }
    console.error(
      `${fname}: ${a.w}x${a.h}  topY=${a.topY}  topCx=${a.topCx}  Δ=(${dx >= 0 ? '+' : ''}${dx}, ${dy >= 0 ? '+' : ''}${dy})`,
    )
  }

  if (printOnly) return
  await mkdir(dirname(outPath), { recursive: true })
  /** dx/dy 为「以 ref 像素为基准、贴图需要被向 +dx +dy 平移以对齐 ref」 */
  await writeFile(
    outPath,
    JSON.stringify(
      {
        reference: REFERENCE,
        refSize: { w: refAnchor.w, h: refAnchor.h },
        nudgePx: nudge,
        method: 'hair-top + median-x',
      },
      null,
      2,
    ),
  )
  console.error(`\n写入 ${outPath}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
