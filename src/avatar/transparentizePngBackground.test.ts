import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { transparentizeStudioBackgroundPng } from './transparentizePngBackground.js'

function makeGrayBgRedCenter(w: number, h: number): Buffer {
  const buf = Buffer.alloc(w * h * 4, 0)
  const cx = (w - 1) / 2
  const cy = (h - 1) / 2
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const inCenter = Math.abs(x - cx) < 3 && Math.abs(y - cy) < 3
      if (inCenter) {
        buf[i] = 255
        buf[i + 1] = 0
        buf[i + 2] = 0
        buf[i + 3] = 255
      } else {
        buf[i] = 210
        buf[i + 1] = 210
        buf[i + 2] = 214
        buf[i + 3] = 255
      }
    }
  }
  return buf
}

describe('transparentizeStudioBackgroundPng', () => {
  it('makes edge-connected background transparent, keeps center', async () => {
    const raw = makeGrayBgRedCenter(24, 24)
    const png = await sharp(raw, { raw: { width: 24, height: 24, channels: 4 } }).png().toBuffer()
    const out = await transparentizeStudioBackgroundPng(png, 48)
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true })
    expect(info.channels).toBe(4)
    const w = info.width
    const idx = (x: number, y: number) => (y * w + x) * 4
    expect(data[idx(0, 0) + 3]).toBe(0)
    expect(data[idx(12, 12) + 3]).toBeGreaterThan(200)
    expect(data[idx(12, 12)]).toBe(255)
  })
})
