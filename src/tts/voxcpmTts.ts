import { readFile } from 'fs/promises'
import { isAbsolute, resolve } from 'path'
import type { VoxcpmTtsConfig } from '../config/types.js'
import type { TtsEngine, TtsStreamEmit } from './engine.js'

const DEFAULT_TIMEOUT_MS = 120_000

function trimBaseUrl(u: string): string {
  return u.replace(/\/+$/, '')
}

function parseIntHeader(h: Headers, name: string, fallback: number): number {
  const v = h.get(name) ?? h.get(name.toLowerCase())
  if (!v) return fallback
  const n = parseInt(v, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

async function buildStreamForm(
  text: string,
  cfg: VoxcpmTtsConfig,
  referenceResolved: string | null,
  cwd: string,
): Promise<FormData> {
  const body = new FormData()
  body.set('text', text)
  body.set('control_instruction', cfg.controlInstruction?.trim() ?? '')
  body.set('cfg_value', String(cfg.cfgValue ?? 2.0))
  body.set('inference_timesteps', String(cfg.inferenceTimesteps ?? 20))
  body.set('normalize', cfg.normalize === true ? 'true' : 'false')
  const amp = cfg.amplitudeNormalize ?? 'rms'
  body.set('amplitude_normalize', amp)
  body.set('denoise', cfg.denoise === false ? 'false' : 'true')
  if (referenceResolved) {
    const buf = await readFile(referenceResolved)
    const blob = new Blob([new Uint8Array(buf)])
    body.set('reference_audio', blob, 'reference.wav')
  }
  return body
}

export function createVoxcpmTts(cfg: VoxcpmTtsConfig, cwd = process.cwd()): TtsEngine {
  const base = trimBaseUrl(cfg.baseUrl)
  const streamUrl = `${base}/api/tts/stream`
  const fullUrl = `${base}/api/tts`
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const referenceResolved =
    cfg.referenceAudioPath != null && cfg.referenceAudioPath.trim()
      ? isAbsolute(cfg.referenceAudioPath)
        ? cfg.referenceAudioPath
        : resolve(cwd, cfg.referenceAudioPath)
      : null

  async function synthesizeStreamImpl(text: string, emit: TtsStreamEmit): Promise<void> {
    const body = await buildStreamForm(text, cfg, referenceResolved, cwd)
    const res = await fetch(streamUrl, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`VoxCPM TTS stream HTTP ${res.status}: ${t.slice(0, 500)}`)
    }
    const sampleRate = parseIntHeader(res.headers, 'x-sample-rate', 48_000)
    const channels = parseIntHeader(res.headers, 'x-channels', 1)
    const frameBytes = Math.max(2, channels) * 2
    /* 首包至少 ~50ms，减少细碎片段与浏览器侧 BufferSource 数量，长对话时更不易卡顿/爆音 */
    const firstMin = Math.max(1536, Math.floor(0.05 * sampleRate) * frameBytes)
    const STEADY_BLOCK = Math.max(8192, firstMin * 2)
    const FIRST_CAP = Math.max(6144, firstMin + 2048)

    let carry = Buffer.alloc(0)
    let firstEmit = true

    const tryEmit = async (flush: boolean): Promise<void> => {
      for (;;) {
        const aligned = Math.floor(carry.length / frameBytes) * frameBytes
        if (aligned < frameBytes) return
        const minNeed = firstEmit ? firstMin : STEADY_BLOCK
        if (!flush && aligned < minNeed) return

        let take: number
        if (flush) {
          take = aligned
        } else {
          const maxBlock = firstEmit ? Math.min(STEADY_BLOCK, FIRST_CAP) : STEADY_BLOCK
          take = Math.floor(Math.min(aligned, Math.max(maxBlock, minNeed)) / frameBytes) * frameBytes
        }
        if (take < frameBytes) return

        const slice = carry.subarray(0, take)
        carry = carry.subarray(take)
        await emit({
          data: Buffer.from(slice),
          format: 'pcm_s16le',
          sampleRate,
          channels,
        })
        firstEmit = false
      }
    }

    const reader = res.body?.getReader()
    if (!reader) {
      throw new Error('VoxCPM TTS stream: 无响应体')
    }
    const streamReadMs = Math.max(timeoutMs * 4, 600_000)
    const deadline = Date.now() + streamReadMs
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error('VoxCPM TTS stream: 读取超时')
      }
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      carry = Buffer.concat([carry, Buffer.from(value)])
      await tryEmit(false)
    }
    await tryEmit(true)
  }

  function wavSampleRateFromBuffer(buf: Buffer): number {
    if (buf.length < 28 || buf.toString('ascii', 0, 4) !== 'RIFF') return 48_000
    return buf.readUInt32LE(24) || 48_000
  }

  return {
    synthesizeStream: synthesizeStreamImpl,

    async synthesize(text: string) {
      const body = await buildStreamForm(text, cfg, referenceResolved, cwd)
      const res = await fetch(fullUrl, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) {
        const t = await res.text().catch(() => '')
        throw new Error(`VoxCPM TTS HTTP ${res.status}: ${t.slice(0, 500)}`)
      }
      const data = Buffer.from(await res.arrayBuffer())
      return {
        data,
        format: 'wav' as const,
        sampleRate: wavSampleRateFromBuffer(data),
      }
    },
  }
}

export async function checkVoxcpmTtsHealth(cfg: VoxcpmTtsConfig): Promise<string> {
  const base = trimBaseUrl(cfg.baseUrl)
  const res = await fetch(`${base}/health`, {
    signal: AbortSignal.timeout(3000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`VoxCPM health HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  return await res.text()
}
