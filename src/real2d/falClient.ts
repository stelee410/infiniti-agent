import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { Real2dFalConfig } from './protocol.js'

export type FalAvatarRenderRequest = {
  sourceImagePath?: string
  imageUrl?: string
  audio: Buffer
  audioFormat: 'mp3' | 'wav' | 'pcm_s16le'
  sampleRate: number
  channels: number
  text?: string
  fal: Real2dFalConfig
}

export type FalAvatarRenderResult = {
  videoUrl: string
  requestId: string
}

type FalSubmitResponse = {
  request_id?: string
  requestId?: string
  status_url?: string
  response_url?: string
}

type FalStatusResponse = {
  status?: string
}

export async function renderFalAiAvatar(req: FalAvatarRenderRequest): Promise<FalAvatarRenderResult> {
  const key = resolveFalKey(req.fal)
  const model = req.fal.model ?? 'fal-ai/ai-avatar'
  const input = await buildAiAvatarInput(req)
  const submitted = await falRequest<FalSubmitResponse>(`https://queue.fal.run/${model}`, key, {
    method: 'POST',
    body: JSON.stringify(input),
  })
  const requestId = submitted.request_id ?? submitted.requestId
  const statusUrl = submitted.status_url ?? `https://queue.fal.run/${model}/requests/${requestId}/status`
  const responseUrl = submitted.response_url ?? `https://queue.fal.run/${model}/requests/${requestId}`
  if (!requestId) throw new Error('fal submit response missing request_id')

  const timeoutMs = req.fal.requestTimeoutMs ?? 300000
  const pollMs = req.fal.pollIntervalMs ?? 1000
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await falRequest<FalStatusResponse>(`${statusUrl}${statusUrl.includes('?') ? '&' : '?'}logs=1`, key)
    if (status.status === 'COMPLETED') {
      const result = await falRequest<unknown>(responseUrl, key)
      const videoUrl = extractFalVideoUrl(result)
      if (!videoUrl) throw new Error('fal result missing video.url')
      return { videoUrl, requestId }
    }
    if (status.status && status.status !== 'IN_QUEUE' && status.status !== 'IN_PROGRESS') {
      throw new Error(`fal request ${requestId} ended with status ${status.status}`)
    }
    await delay(pollMs)
  }
  throw new Error(`fal request ${requestId} timed out after ${timeoutMs}ms`)
}

async function buildAiAvatarInput(req: FalAvatarRenderRequest): Promise<Record<string, unknown>> {
  const imageUrl = req.fal.imageUrl ?? req.imageUrl ?? await imagePathToDataUri(req.sourceImagePath)
  if (!imageUrl) throw new Error('fal ai-avatar requires real2d.sourceImage or real2d.fal.imageUrl')
  const audioUrl = req.fal.audioUrl ?? audioToDataUri(req.audio, req.audioFormat, req.sampleRate, req.channels)
  const options = req.fal.options ?? {}
  return {
    image_url: imageUrl,
    audio_url: audioUrl,
    prompt: options.prompt ?? 'A friendly virtual assistant speaking naturally to the viewer.',
    num_frames: options.num_frames ?? options.numFrames,
    resolution: options.resolution ?? '480p',
    seed: options.seed,
    acceleration: options.acceleration ?? 'regular',
  }
}

async function imagePathToDataUri(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined
  const data = await readFile(path)
  const ext = extname(path).toLowerCase()
  const mime =
    ext === '.jpg' || ext === '.jpeg'
      ? 'image/jpeg'
      : ext === '.webp'
        ? 'image/webp'
        : ext === '.gif'
          ? 'image/gif'
          : 'image/png'
  return `data:${mime};base64,${data.toString('base64')}`
}

function audioToDataUri(audio: Buffer, format: FalAvatarRenderRequest['audioFormat'], sampleRate: number, channels: number): string {
  if (format === 'mp3') return `data:audio/mpeg;base64,${audio.toString('base64')}`
  if (format === 'wav') return `data:audio/wav;base64,${audio.toString('base64')}`
  const wav = pcmS16leToWav(audio, sampleRate, channels)
  return `data:audio/wav;base64,${wav.toString('base64')}`
}

function pcmS16leToWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const header = Buffer.alloc(44)
  const byteRate = sampleRate * channels * 2
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(channels * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function resolveFalKey(fal: Real2dFalConfig): string {
  const envName = fal.keyEnv ?? 'FAL_KEY'
  const key = fal.apiKey ?? process.env[envName]
  if (!key?.trim()) throw new Error(`fal API key missing; set ${envName}`)
  return key.trim()
}

async function falRequest<T>(url: string, key: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Key ${key}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`fal ${res.status}: ${text.slice(0, 300)}`)
  }
  return await res.json() as T
}

function extractFalVideoUrl(result: unknown): string | undefined {
  const data = result && typeof result === 'object' ? result as Record<string, unknown> : {}
  const video = data.video && typeof data.video === 'object' ? data.video as Record<string, unknown> : undefined
  return typeof video?.url === 'string' ? video.url : undefined
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
