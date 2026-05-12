import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import {
  AVATAR_CHROMA_KEY_BLUE,
  AVATAR_CHROMA_KEY_GREEN,
  resolveAvatarChromaKeyColorFromEnv,
  transparentizeStudioBackgroundPng,
} from './transparentizePngBackground.js'

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

  it('can use chroma key green as the cutout reference color', async () => {
    const raw = Buffer.alloc(24 * 24 * 4, 0)
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 24; x++) {
        const i = (y * 24 + x) * 4
        const inCenter = x >= 8 && x < 16 && y >= 8 && y < 16
        raw[i] = inCenter ? 255 : 0
        raw[i + 1] = inCenter ? 0 : 255
        raw[i + 2] = 0
        raw[i + 3] = 255
      }
    }
    const png = await sharp(raw, { raw: { width: 24, height: 24, channels: 4 } }).png().toBuffer()
    const out = await transparentizeStudioBackgroundPng(png, { backgroundColor: AVATAR_CHROMA_KEY_GREEN })
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true })
    const idx = (x: number, y: number) => (y * info.width + x) * 4
    expect(data[idx(0, 0) + 3]).toBe(0)
    expect(data[idx(12, 12) + 3]).toBe(255)
    expect(data[idx(12, 12)]).toBe(255)
  })

  it('keys uneven saturated green by hue, not only exact RGB distance', async () => {
    const raw = Buffer.alloc(24 * 24 * 4, 0)
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 24; x++) {
        const i = (y * 24 + x) * 4
        const inCenter = x >= 8 && x < 16 && y >= 8 && y < 16
        raw[i] = inCenter ? 180 : 12
        raw[i + 1] = inCenter ? 60 : 235
        raw[i + 2] = inCenter ? 40 : 18
        raw[i + 3] = 255
      }
    }
    const png = await sharp(raw, { raw: { width: 24, height: 24, channels: 4 } }).png().toBuffer()
    const out = await transparentizeStudioBackgroundPng(png, { backgroundColor: AVATAR_CHROMA_KEY_GREEN })
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true })
    const idx = (x: number, y: number) => (y * info.width + x) * 4
    expect(data[idx(0, 0) + 3]).toBe(0)
    expect(data[idx(12, 12) + 3]).toBe(255)
  })

  it('can use chroma key blue as the cutout reference color', async () => {
    const raw = Buffer.alloc(24 * 24 * 4, 0)
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 24; x++) {
        const i = (y * 24 + x) * 4
        const inCenter = x >= 8 && x < 16 && y >= 8 && y < 16
        raw[i] = inCenter ? 255 : 0
        raw[i + 1] = 0
        raw[i + 2] = inCenter ? 0 : 255
        raw[i + 3] = 255
      }
    }
    const png = await sharp(raw, { raw: { width: 24, height: 24, channels: 4 } }).png().toBuffer()
    const out = await transparentizeStudioBackgroundPng(png, { backgroundColor: AVATAR_CHROMA_KEY_BLUE })
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true })
    const idx = (x: number, y: number) => (y * info.width + x) * 4
    expect(data[idx(0, 0) + 3]).toBe(0)
    expect(data[idx(12, 12) + 3]).toBe(255)
  })

  it('softens alpha and suppresses green spill on foreground edges', async () => {
    const raw = Buffer.alloc(24 * 24 * 4, 0)
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 24; x++) {
        const i = (y * 24 + x) * 4
        const inCenter = x >= 8 && x < 16 && y >= 8 && y < 16
        if (inCenter) {
          const edge = x === 8 || x === 15 || y === 8 || y === 15
          raw[i] = edge ? 100 : 190
          raw[i + 1] = edge ? 135 : 55
          raw[i + 2] = edge ? 100 : 45
        } else {
          raw[i] = 0
          raw[i + 1] = 255
          raw[i + 2] = 0
        }
        raw[i + 3] = 255
      }
    }
    const png = await sharp(raw, { raw: { width: 24, height: 24, channels: 4 } }).png().toBuffer()
    const out = await transparentizeStudioBackgroundPng(png, { backgroundColor: AVATAR_CHROMA_KEY_GREEN })
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true })
    const idx = (x: number, y: number) => (y * info.width + x) * 4
    expect(data[idx(0, 0) + 3]).toBe(0)
    expect(data[idx(8, 12) + 1]).toBeLessThan(135)
    expect(data[idx(8, 12) + 3]).toBeGreaterThan(200)
    expect(data[idx(8, 12) + 3]).toBeLessThan(255)
    expect(data[idx(12, 12) + 3]).toBe(255)
  })

  it('resolves green by default and blue from env', () => {
    const oldKey = process.env.INFINITI_AVATAR_KEY_COLOR
    const oldChroma = process.env.INFINITI_AVATAR_CHROMA_KEY_COLOR
    try {
      delete process.env.INFINITI_AVATAR_KEY_COLOR
      delete process.env.INFINITI_AVATAR_CHROMA_KEY_COLOR
      expect(resolveAvatarChromaKeyColorFromEnv()).toBe(AVATAR_CHROMA_KEY_GREEN)
      process.env.INFINITI_AVATAR_KEY_COLOR = 'blue'
      expect(resolveAvatarChromaKeyColorFromEnv()).toBe(AVATAR_CHROMA_KEY_BLUE)
      process.env.INFINITI_AVATAR_KEY_COLOR = AVATAR_CHROMA_KEY_GREEN
      expect(resolveAvatarChromaKeyColorFromEnv()).toBe(AVATAR_CHROMA_KEY_GREEN)
    } finally {
      if (oldKey === undefined) delete process.env.INFINITI_AVATAR_KEY_COLOR
      else process.env.INFINITI_AVATAR_KEY_COLOR = oldKey
      if (oldChroma === undefined) delete process.env.INFINITI_AVATAR_CHROMA_KEY_COLOR
      else process.env.INFINITI_AVATAR_CHROMA_KEY_COLOR = oldChroma
    }
  })
})
