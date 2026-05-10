import { readFile } from 'fs/promises'
import { isAbsolute, resolve } from 'path'
import type { MossTtsNanoConfig } from '../config/types.js'
import type { TtsEngine, TtsStreamEmit } from './engine.js'

const DEFAULT_TIMEOUT_MS = 120_000

function trimBaseUrl(u: string): string {
  return u.replace(/\/+$/, '')
}

function resolveAgainstBase(base: string, pathOrUrl: string): string {
  const p = String(pathOrUrl).trim()
  if (p.startsWith('http://') || p.startsWith('https://')) return p
  const path = p.startsWith('/') ? p : `/${p}`
  return new URL(path, `${base}/`).href
}

/** PCM s16le interleaved → 带 WAV 头的整段 buffer（供 synthesize 聚合或非流式客户端）。 */
function pcm16leToWav(pcm: Buffer, sampleRate: number, numChannels: number): Buffer {
  const bitsPerSample = 16
  const blockAlign = (numChannels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign
  const dataSize = pcm.length
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(numChannels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)
  return Buffer.concat([header, pcm])
}

async function buildPromptForm(
  text: string,
  demoId: string,
  promptResolved: string | null,
): Promise<FormData> {
  const body = new FormData()
  body.set('text', text)
  body.set('enable_text_normalization', '0')
  body.set('enable_normalize_tts_text', '1')
  if (demoId) body.set('demo_id', demoId)
  if (promptResolved) {
    const buf = await readFile(promptResolved)
    const blob = new Blob([new Uint8Array(buf)])
    body.set('prompt_audio', blob, 'prompt.wav')
  }
  return body
}

export function createMossTtsNano(cfg: MossTtsNanoConfig, cwd = process.cwd()): TtsEngine {
  const base = trimBaseUrl(cfg.baseUrl)
  const startUrl = `${base}/api/generate-stream/start`
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const promptResolved =
    cfg.promptAudioPath != null && cfg.promptAudioPath.trim()
      ? isAbsolute(cfg.promptAudioPath)
        ? cfg.promptAudioPath
        : resolve(cwd, cfg.promptAudioPath)
      : null
  const demoId = cfg.demoId?.trim() || ''

  if (!promptResolved && !demoId) {
    throw new Error(
      'MOSS-TTS-Nano：请在 tts 中配置 promptAudioPath（参考 wav）或 demoId（服务端内置 demo）之一',
    )
  }

  async function startStreamJson(text: string): Promise<{
    streamId: string
    audioUrl: string
    sampleRate: number
    channels: number
  }> {
    const body = await buildPromptForm(text, demoId, promptResolved)
    const res = await fetch(startUrl, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const rawText = await res.text()
    if (!res.ok) {
      throw new Error(`MOSS-TTS-Nano stream start HTTP ${res.status}: ${rawText.slice(0, 500)}`)
    }
    let json: unknown
    try {
      json = JSON.parse(rawText) as Record<string, unknown>
    } catch {
      throw new Error(`MOSS-TTS-Nano stream: 响应不是 JSON: ${rawText.slice(0, 200)}`)
    }
    const o = json as Record<string, unknown>
    if (typeof o.error === 'string' && o.error) {
      throw new Error(`MOSS-TTS-Nano stream: ${o.error}`)
    }
    const streamId = o.stream_id
    const audioPath = o.audio_url
    if (typeof streamId !== 'string' || !streamId.trim()) {
      throw new Error('MOSS-TTS-Nano stream: 响应缺少 stream_id')
    }
    if (typeof audioPath !== 'string' || !audioPath.trim()) {
      throw new Error('MOSS-TTS-Nano stream: 响应缺少 audio_url')
    }
    const sr = o.sample_rate
    let sampleRate = 48000
    if (typeof sr === 'number' && Number.isFinite(sr)) sampleRate = Math.floor(sr)
    else if (typeof sr === 'string' && /^\d+$/.test(sr)) sampleRate = parseInt(sr, 10)
    const ch = o.channels
    let channels = 2
    if (typeof ch === 'number' && Number.isFinite(ch) && ch >= 1 && ch <= 8) channels = Math.floor(ch)
    else if (typeof ch === 'string' && /^[12]$/.test(ch)) channels = parseInt(ch, 10)
    return {
      streamId: streamId.trim(),
      audioUrl: resolveAgainstBase(base, audioPath.trim()),
      sampleRate,
      channels,
    }
  }

  async function postClose(streamId: string): Promise<void> {
    const closeHref = resolveAgainstBase(base, `/api/generate-stream/${encodeURIComponent(streamId)}/close`)
    try {
      await fetch(closeHref, { method: 'POST', signal: AbortSignal.timeout(30_000) })
    } catch {
      /* 清理失败可忽略 */
    }
  }

  async function synthesizeStreamImpl(
    text: string,
    emit: TtsStreamEmit,
    externalSignal?: AbortSignal,
  ): Promise<void> {
    const { streamId, audioUrl, sampleRate, channels } = await startStreamJson(text)
    const frameBytes = Math.max(2, channels) * 2
    /**
     * 首包小 → 首字快；稳态块不宜过大：MOSS/CPU 稍慢时，攒太久才 emit 会导致
     * LiveUI 时间线已播完仍无下一块 → 听感断续（不等同于「裂音」，是 underrun）。
     * 块略多会增加 WS/base64 开销，一般仍可接受。
     */
    const FIRST_MIN = 1536
    const STEADY_BLOCK = 8192
    const FIRST_CAP = 6144

    let carry = Buffer.alloc(0)
    let firstEmit = true

    const tryEmit = async (flush: boolean): Promise<void> => {
      for (;;) {
        const aligned = Math.floor(carry.length / frameBytes) * frameBytes
        if (aligned < frameBytes) return
        const minNeed = firstEmit ? FIRST_MIN : STEADY_BLOCK
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

    try {
      const streamReadMs = Math.max(timeoutMs * 4, 600_000)
      const audioSignal = externalSignal
        ? AbortSignal.any([AbortSignal.timeout(streamReadMs), externalSignal])
        : AbortSignal.timeout(streamReadMs)
      const audioRes = await fetch(audioUrl, {
        method: 'GET',
        signal: audioSignal,
      })
      if (!audioRes.ok) {
        const t = await audioRes.text().catch(() => '')
        throw new Error(`MOSS-TTS-Nano stream audio HTTP ${audioRes.status}: ${t.slice(0, 300)}`)
      }
      const reader = audioRes.body?.getReader()
      if (!reader) {
        throw new Error('MOSS-TTS-Nano stream: 无响应体')
      }

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value || value.byteLength === 0) continue
        carry = Buffer.concat([carry, Buffer.from(value)])
        await tryEmit(false)
      }
      await tryEmit(true)
    } finally {
      await postClose(streamId)
    }
  }

  return {
    synthesizeStream: synthesizeStreamImpl,

    /** 聚合整段 PCM 为单 WAV（测试或非流式调用）。 */
    async synthesize(text: string) {
      const chunks: Buffer[] = []
      let sr = 48000
      let ch = 2
      await synthesizeStreamImpl(text, async (out) => {
        if (out.format === 'pcm_s16le') {
          chunks.push(out.data)
          sr = out.sampleRate
          ch = out.channels ?? 2
        }
      })
      const pcm = Buffer.concat(chunks)
      if (pcm.length === 0) {
        return { data: Buffer.alloc(0), format: 'wav' as const, sampleRate: sr }
      }
      return {
        data: pcm16leToWav(pcm, sr, ch),
        format: 'wav' as const,
        sampleRate: sr,
      }
    },
  }
}
