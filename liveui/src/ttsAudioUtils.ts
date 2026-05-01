export type PcmAudioMeta = {
  sampleRate: number
  channels: number
}

export type PcmAudioChunk = PcmAudioMeta & {
  pcm: Uint8Array
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const len = bin.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i) & 0xff
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

export function normalizePcmAudioMeta(sampleRate: unknown, channels: unknown): PcmAudioMeta {
  return {
    sampleRate:
      typeof sampleRate === 'number' && sampleRate > 0 && sampleRate < 1_000_000
        ? sampleRate
        : 48_000,
    channels:
      typeof channels === 'number' && channels >= 1 && channels <= 8
        ? Math.floor(channels)
        : 1,
  }
}

export function coalesceTargetBytes(sampleRate: number, channels: number, targetSec: number): number {
  const ch = Math.max(1, channels)
  const frames = Math.max(1, Math.floor(targetSec * sampleRate))
  return frames * 2 * ch
}

export class PcmS16Coalescer {
  private slop: Uint8Array | null = null
  private meta: PcmAudioMeta | null = null

  constructor(private readonly targetSec: number) {}

  append(pcm: Uint8Array, sampleRate: number, channels: number): PcmAudioChunk[] {
    const nextMeta = { sampleRate, channels: Math.max(1, Math.min(8, channels)) }
    const out: PcmAudioChunk[] = []
    if (this.meta && (this.meta.sampleRate !== nextMeta.sampleRate || this.meta.channels !== nextMeta.channels)) {
      out.push(...this.flush(true))
    }
    this.meta = nextMeta
    this.slop = concatBytes(this.slop, pcm)
    out.push(...this.takeReadyChunks())
    return out
  }

  flush(forceAll: boolean): PcmAudioChunk[] {
    if (!this.slop || !this.meta) {
      if (forceAll) this.reset()
      return []
    }
    const frameBytes = 2 * this.meta.channels
    const byteCount = Math.floor(this.slop.length / frameBytes) * frameBytes
    if (byteCount < frameBytes) {
      if (forceAll) this.reset()
      return []
    }
    const part = this.slop.subarray(0, byteCount)
    this.slop = this.slop.length > byteCount ? this.slop.subarray(byteCount) : null
    const chunk = { ...this.meta, pcm: copyBytes(part) }
    if (forceAll) this.reset()
    return [chunk]
  }

  reset(): void {
    this.slop = null
    this.meta = null
  }

  get currentMeta(): PcmAudioMeta | null {
    return this.meta
  }

  private takeReadyChunks(): PcmAudioChunk[] {
    if (!this.slop || !this.meta) return []
    const need = coalesceTargetBytes(this.meta.sampleRate, this.meta.channels, this.targetSec)
    const out: PcmAudioChunk[] = []
    while (this.slop && this.slop.length >= need) {
      const part = this.slop.subarray(0, need)
      this.slop = this.slop.length > need ? this.slop.subarray(need) : null
      out.push({ ...this.meta, pcm: copyBytes(part) })
    }
    return out
  }
}

function concatBytes(left: Uint8Array | null, right: Uint8Array): Uint8Array {
  if (!left) return right
  const merged = new Uint8Array(left.length + right.length)
  merged.set(left, 0)
  merged.set(right, left.length)
  return merged
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length)
  out.set(bytes)
  return out
}
