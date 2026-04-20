import sharp from 'sharp'

const DEFAULT_TOLERANCE = 38

function rgbDistSq(r: number, g: number, b: number, br: number, bg: number, bb: number): number {
  const dr = r - br
  const dg = g - bg
  const db = b - bb
  return dr * dr + dg * dg + db * db
}

function saturation(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b)
  if (mx <= 0) return 0
  const mn = Math.min(r, g, b)
  return (mx - mn) / mx
}

function median(arr: number[]): number {
  if (!arr.length) return 0
  const s = arr.slice().sort((a, b) => a - b)
  return s[s.length >> 1]!
}

/**
 * 抠去摄影棚式纯色 / 单一光源浅色背景：
 * - 四条边带各取「低饱和」像素的中位 RGB 作为多个 reference 颜色（应对左右/上下亮度不一致）
 * - BFS 从所有低饱和的边缘像素开始；扩散判定：
 *     · 与已接受邻居颜色 ≤ STEP_TOL（链式步长，吞掉渐变）
 *     · 或与任一 reference 距离 ≤ globalTol（吞掉孤立同色块）
 *     · 且像素自身饱和度 ≤ SAT_MAX（避免吃到肤色 / 衣服 / 头发）
 */
export async function transparentizeStudioBackgroundPng(
  input: Buffer,
  tolerance: number = DEFAULT_TOLERANCE,
): Promise<Buffer> {
  const tol = Math.max(8, Math.min(120, tolerance))
  const globalTolSq = (tol + 10) * (tol + 10)
  const STEP_TOL = 18
  const STEP_SQ = STEP_TOL * STEP_TOL
  const SAT_MAX = 0.18

  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const w = info.width
  const h = info.height
  const ch = info.channels
  if (ch !== 4 || w < 2 || h < 2) {
    return sharp(input).png().toBuffer()
  }

  const idx = (x: number, y: number): number => (y * w + x) * 4

  const bandDepth = Math.max(8, Math.min(64, Math.round(Math.min(w, h) * 0.04)))

  type Ref = { r: number; g: number; b: number }
  const refs: Ref[] = []

  const collectRef = (xMin: number, yMin: number, xMax: number, yMax: number): void => {
    const rs: number[] = []
    const gs: number[] = []
    const bs: number[] = []
    for (let y = yMin; y < yMax; y++) {
      for (let x = xMin; x < xMax; x++) {
        const i = idx(x, y)
        const r = data[i]!
        const g = data[i + 1]!
        const b = data[i + 2]!
        if (saturation(r, g, b) <= SAT_MAX) {
          rs.push(r)
          gs.push(g)
          bs.push(b)
        }
      }
    }
    if (rs.length > 32) {
      refs.push({ r: median(rs), g: median(gs), b: median(bs) })
    }
  }

  collectRef(0, 0, w, bandDepth)
  collectRef(0, h - bandDepth, w, h)
  collectRef(0, 0, bandDepth, h)
  collectRef(w - bandDepth, 0, w, h)

  /** 即使每条边都"高饱和"被丢弃也兜底取一个全局边均值 */
  if (refs.length === 0) {
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
    refs.push({ r: sr / n, g: sg / n, b: sb / n })
  }

  const matchesAnyRef = (r: number, g: number, b: number): boolean => {
    for (const ref of refs) {
      if (rgbDistSq(r, g, b, ref.r, ref.g, ref.b) <= globalTolSq) return true
    }
    return false
  }

  const visited = new Uint8Array(w * h)
  const qx: number[] = []
  const qy: number[] = []

  const seedEdge = (x: number, y: number): void => {
    const p = y * w + x
    if (visited[p]) return
    const i = p * 4
    const r = data[i]!
    const g = data[i + 1]!
    const b = data[i + 2]!
    if (saturation(r, g, b) > SAT_MAX) return
    visited[p] = 1
    data[i + 3] = 0
    qx.push(x)
    qy.push(y)
  }

  for (let x = 0; x < w; x++) {
    seedEdge(x, 0)
    seedEdge(x, h - 1)
  }
  for (let y = 0; y < h; y++) {
    seedEdge(0, y)
    seedEdge(w - 1, y)
  }

  const tryEnqueue = (x: number, y: number, fr: number, fg: number, fb: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return
    const p = y * w + x
    if (visited[p]) return
    const i = p * 4
    const r = data[i]!
    const g = data[i + 1]!
    const b = data[i + 2]!
    if (saturation(r, g, b) > SAT_MAX) return
    const stepOk = rgbDistSq(r, g, b, fr, fg, fb) <= STEP_SQ
    const refOk = matchesAnyRef(r, g, b)
    if (!stepOk && !refOk) return
    visited[p] = 1
    data[i + 3] = 0
    qx.push(x)
    qy.push(y)
  }

  let head = 0
  while (head < qx.length) {
    const x = qx[head]!
    const y = qy[head]!
    head++
    const i = idx(x, y)
    const fr = data[i]!
    const fg = data[i + 1]!
    const fb = data[i + 2]!
    tryEnqueue(x + 1, y, fr, fg, fb)
    tryEnqueue(x - 1, y, fr, fg, fb)
    tryEnqueue(x, y + 1, fr, fg, fb)
    tryEnqueue(x, y - 1, fr, fg, fb)
  }

  /**
   * 预乘 alpha：alpha=0 像素 RGB 归零，避免 mesh 双线性插值把白色泄漏成"白晕"。
   * 不做边缘 erosion，保留主体轮廓的完整像素。
   */
  for (let p = 0; p < w * h; p++) {
    if (visited[p]) {
      const i = p * 4
      data[i] = 0
      data[i + 1] = 0
      data[i + 2] = 0
      data[i + 3] = 0
    }
  }

  return sharp(Buffer.from(data), { raw: { width: w, height: h, channels: 4 } }).png().toBuffer()
}
