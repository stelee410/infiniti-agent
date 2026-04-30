import { describe, expect, it } from 'vitest'
import {
  PcmS16Coalescer,
  base64ToArrayBuffer,
  coalesceTargetBytes,
  normalizePcmAudioMeta,
} from './ttsAudioUtils.ts'

describe('ttsAudioUtils', () => {
  it('decodes base64 into a detached ArrayBuffer', () => {
    const bytes = new Uint8Array(base64ToArrayBuffer('AQIDBA=='))
    expect([...bytes]).toEqual([1, 2, 3, 4])
  })

  it('normalizes PCM metadata from optional wire fields', () => {
    expect(normalizePcmAudioMeta(16_000, 2.8)).toEqual({ sampleRate: 16_000, channels: 2 })
    expect(normalizePcmAudioMeta(-1, 99)).toEqual({ sampleRate: 48_000, channels: 1 })
  })

  it('computes target coalescing bytes from sample rate and channels', () => {
    expect(coalesceTargetBytes(1000, 2, 0.05)).toBe(200)
    expect(coalesceTargetBytes(1000, 0, 0)).toBe(2)
  })

  it('coalesces small PCM chunks and flushes frame-aligned leftovers', () => {
    const c = new PcmS16Coalescer(0.002)
    expect(c.append(new Uint8Array([1, 2]), 1000, 1)).toEqual([])
    expect(c.append(new Uint8Array([3, 4]), 1000, 1).map((x) => [...x.pcm])).toEqual([[1, 2, 3, 4]])
    expect(c.append(new Uint8Array([5, 6, 7]), 1000, 1)).toEqual([])
    expect(c.flush(false).map((x) => [...x.pcm])).toEqual([[5, 6]])
    expect(c.flush(true)).toEqual([])
  })

  it('flushes existing slop before switching PCM metadata', () => {
    const c = new PcmS16Coalescer(1)
    expect(c.append(new Uint8Array([1, 2, 3, 4]), 1000, 1)).toEqual([])
    const out = c.append(new Uint8Array([5, 6, 7, 8]), 2000, 1)
    expect(out.map((x) => ({ sampleRate: x.sampleRate, channels: x.channels, pcm: [...x.pcm] }))).toEqual([
      { sampleRate: 1000, channels: 1, pcm: [1, 2, 3, 4] },
    ])
    expect(c.currentMeta).toEqual({ sampleRate: 2000, channels: 1 })
    expect(c.flush(true).map((x) => [...x.pcm])).toEqual([[5, 6, 7, 8]])
  })
})
