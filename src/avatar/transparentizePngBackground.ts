import sharp from 'sharp'

const DEFAULT_TOLERANCE = 38
const DEFAULT_CHROMA_HUE_TOLERANCE = 34
export const AVATAR_CHROMA_KEY_GREEN = '#00ff00'
export const AVATAR_CHROMA_KEY_BLUE = '#0000ff'

export type TransparentizeBackgroundOptions = {
  tolerance?: number
  backgroundColor?: `#${string}` | { r: number; g: number; b: number }
}

function rgbDistSq(r: number, g: number, b: number, br: number, bg: number, bb: number): number {
  const dr = r - br
  const dg = g - bg
  const db = b - bb
  return dr * dr + dg * dg + db * db
}

function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i)
  if (!m) throw new Error(`无效背景色: ${hex}`)
  const n = Number.parseInt(m[1]!, 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

export function resolveAvatarChromaKeyColorFromEnv(): typeof AVATAR_CHROMA_KEY_GREEN | typeof AVATAR_CHROMA_KEY_BLUE {
  const raw = (process.env.INFINITI_AVATAR_KEY_COLOR ?? process.env.INFINITI_AVATAR_CHROMA_KEY_COLOR ?? '').trim().toLowerCase()
  if (!raw || raw === 'green' || raw === AVATAR_CHROMA_KEY_GREEN) return AVATAR_CHROMA_KEY_GREEN
  if (raw === 'blue' || raw === AVATAR_CHROMA_KEY_BLUE) return AVATAR_CHROMA_KEY_BLUE
  throw new Error(`INFINITI_AVATAR_KEY_COLOR 只支持 ${AVATAR_CHROMA_KEY_GREEN} / ${AVATAR_CHROMA_KEY_BLUE} / green / blue`)
}

function resolveOptions(opts?: number | TransparentizeBackgroundOptions): {
  tolerance: number
  backgroundColor?: { r: number; g: number; b: number }
} {
  if (typeof opts === 'number') return { tolerance: opts }
  const backgroundColor = typeof opts?.backgroundColor === 'string'
    ? parseHexColor(opts.backgroundColor)
    : opts?.backgroundColor
  return {
    tolerance: opts?.tolerance ?? (backgroundColor ? DEFAULT_CHROMA_HUE_TOLERANCE : DEFAULT_TOLERANCE),
    ...(backgroundColor ? { backgroundColor } : {}),
  }
}

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === rn) h = 60 * (((gn - bn) / d) % 6)
    else if (max === gn) h = 60 * ((bn - rn) / d + 2)
    else h = 60 * ((rn - gn) / d + 4)
  }
  if (h < 0) h += 360
  return { h, s: max === 0 ? 0 : d / max, v: max }
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return Math.min(d, 360 - d)
}

function hasRemovedNeighbor(mask: Uint8Array, w: number, h: number, x: number, y: number, radius: number): number {
  let count = 0
  for (let yy = Math.max(0, y - radius); yy <= Math.min(h - 1, y + radius); yy++) {
    for (let xx = Math.max(0, x - radius); xx <= Math.min(w - 1, x + radius); xx++) {
      if (xx === x && yy === y) continue
      if (mask[yy * w + xx]) count++
    }
  }
  return count
}

function cleanupSpill(
  data: Buffer,
  i: number,
  target: { r: number; g: number; b: number; h: number },
  hueTol: number,
): void {
  const r = data[i]!
  const g = data[i + 1]!
  const b = data[i + 2]!
  const hsv = rgbToHsv(r, g, b)
  const nearKeyHue = hsv.s > 0.12 && hueDistance(hsv.h, target.h) <= hueTol * 2
  if (target.g > target.r && target.g > target.b) {
    const greenDominant = g > r + 10 && g > b + 10
    if (!nearKeyHue && !greenDominant) return
    const neutralMax = Math.max(r, b) + 12
    if (g > neutralMax) data[i + 1] = Math.round(g - (g - neutralMax) * 0.65)
    return
  }
  const blueDominant = b > r + 10 && b > g + 10
  if (!nearKeyHue && !blueDominant) return
  const neutralMax = Math.max(r, g) + 12
  if (b > neutralMax) data[i + 2] = Math.round(b - (b - neutralMax) * 0.65)
}

/**
 * 将「与画面边缘平均色接近、且与边缘连通」的像素设为透明。
 * 适用于 plain light gray studio 背景、人物居中的半身像 / 表情 PNG。
 * 传入 backgroundColor 时，改用 HSV 色相范围做 chroma key，并清理边缘溢色。
 */
export async function transparentizeStudioBackgroundPng(
  input: Buffer,
  opts?: number | TransparentizeBackgroundOptions,
): Promise<Buffer> {
  const resolved = resolveOptions(opts)
  const tolerance = resolved.tolerance
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const w = info.width
  const h = info.height
  const ch = info.channels
  if (ch !== 4 || w < 2 || h < 2) {
    return sharp(input).png().toBuffer()
  }

  const idx = (x: number, y: number) => (y * w + x) * 4

  let br = resolved.backgroundColor?.r
  let bg = resolved.backgroundColor?.g
  let bb = resolved.backgroundColor?.b
  const chromaTarget = resolved.backgroundColor
    ? { ...resolved.backgroundColor, h: rgbToHsv(resolved.backgroundColor.r, resolved.backgroundColor.g, resolved.backgroundColor.b).h }
    : undefined
  if (br === undefined || bg === undefined || bb === undefined) {
    let sr = 0
    let sg = 0
    let sb = 0
    let n = 0
    for (let x = 0; x < w; x++) {
      for (const y of [0, h - 1]) {
        const i = idx(x, y)
        sr += data[i]!
        sg += data[i + 1]!
        sb += data[i + 2]!
        n++
      }
    }
    for (let y = 1; y < h - 1; y++) {
      for (const x of [0, w - 1]) {
        const i = idx(x, y)
        sr += data[i]!
        sg += data[i + 1]!
        sb += data[i + 2]!
        n++
      }
    }
    br = sr / n
    bg = sg / n
    bb = sb / n
  }

  const tol = Math.max(8, Math.min(chromaTarget ? 80 : 120, tolerance))
  const tolSq = tol * tol
  const matches = (x: number, y: number): boolean => {
    const i = idx(x, y)
    if (chromaTarget) {
      const hsv = rgbToHsv(data[i]!, data[i + 1]!, data[i + 2]!)
      const closeHue = hueDistance(hsv.h, chromaTarget.h) <= tol
      const highSaturation = hsv.s >= 0.32
      const visibleEnough = hsv.v >= 0.18
      const exactOrAntialiased = rgbDistSq(data[i]!, data[i + 1]!, data[i + 2]!, chromaTarget.r, chromaTarget.g, chromaTarget.b) <= 28 * 28
      return exactOrAntialiased || (closeHue && highSaturation && visibleEnough)
    }
    return rgbDistSq(data[i]!, data[i + 1]!, data[i + 2]!, br, bg, bb) <= tolSq
  }

  const removeMask = new Uint8Array(w * h)
  const qx: number[] = []
  const qy: number[] = []

  const trySeed = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return
    const p = y * w + x
    if (removeMask[p]) return
    if (!matches(x, y)) return
    removeMask[p] = 1
    qx.push(x)
    qy.push(y)
  }

  for (let x = 0; x < w; x++) {
    trySeed(x, 0)
    trySeed(x, h - 1)
  }
  for (let y = 0; y < h; y++) {
    trySeed(0, y)
    trySeed(w - 1, y)
  }

  let head = 0
  while (head < qx.length) {
    const x = qx[head]!
    const y = qy[head]!
    head++
    const neighbors = [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ] as const
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const p = ny * w + nx
      if (removeMask[p]) continue
      if (!matches(nx, ny)) continue
      removeMask[p] = 1
      qx.push(nx)
      qy.push(ny)
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      const i = idx(x, y)
      if (removeMask[p]) {
        data[i + 3] = 0
        continue
      }
      const edgeTouches = hasRemovedNeighbor(removeMask, w, h, x, y, chromaTarget ? 2 : 1)
      if (!edgeTouches) continue
      const alphaDrop = chromaTarget ? Math.min(48, edgeTouches * 5) : Math.min(28, edgeTouches * 4)
      data[i + 3] = Math.max(0, data[i + 3]! - alphaDrop)
      if (chromaTarget) cleanupSpill(data, i, chromaTarget, tol)
    }
  }

  return sharp(Buffer.from(data), { raw: { width: w, height: h, channels: 4 } }).png().toBuffer()
}
