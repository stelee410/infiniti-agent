import sharp from 'sharp'

const DEFAULT_TOLERANCE = 38

function rgbDistSq(r: number, g: number, b: number, br: number, bg: number, bb: number): number {
  const dr = r - br
  const dg = g - bg
  const db = b - bb
  return dr * dr + dg * dg + db * db
}

/**
 * 将「与画面边缘平均色接近、且与边缘连通」的像素设为透明。
 * 适用于 plain light gray studio 背景、人物居中的半身像 / 表情 PNG。
 */
export async function transparentizeStudioBackgroundPng(
  input: Buffer,
  tolerance: number = DEFAULT_TOLERANCE,
): Promise<Buffer> {
  const tol = Math.max(8, Math.min(120, tolerance))
  const tolSq = tol * tol

  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const w = info.width
  const h = info.height
  const ch = info.channels
  if (ch !== 4 || w < 2 || h < 2) {
    return sharp(input).png().toBuffer()
  }

  const idx = (x: number, y: number) => (y * w + x) * 4

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
  const br = sr / n
  const bg = sg / n
  const bb = sb / n

  const matches = (x: number, y: number): boolean => {
    const i = idx(x, y)
    return rgbDistSq(data[i]!, data[i + 1]!, data[i + 2]!, br, bg, bb) <= tolSq
  }

  const visited = new Uint8Array(w * h)
  const qx: number[] = []
  const qy: number[] = []

  const trySeed = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return
    const p = y * w + x
    if (visited[p]) return
    if (!matches(x, y)) return
    visited[p] = 1
    const i = idx(x, y)
    data[i + 3] = 0
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
      if (visited[p]) continue
      if (!matches(nx, ny)) continue
      visited[p] = 1
      const i = idx(nx, ny)
      data[i + 3] = 0
      qx.push(nx)
      qy.push(ny)
    }
  }

  return sharp(Buffer.from(data), { raw: { width: w, height: h, channels: 4 } }).png().toBuffer()
}
