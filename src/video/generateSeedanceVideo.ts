import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { InfinitiConfig, SeedanceVideoConfig } from '../config/types.js'
import { localInboxDir } from '../paths.js'

export type SeedanceVideoResult = {
  path: string
  provider: 'volcengine'
  model: string
  taskId: string
  videoUrl: string
  bytes: number
  status: string
  ratio?: string
  duration?: number
  resolution?: string
}

export type SeedanceReferenceImage = {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
  base64: string
  label?: string
}

type ResolvedSeedanceConfig = Required<Pick<SeedanceVideoConfig, 'provider' | 'baseUrl' | 'apiKey' | 'model'>> &
  Omit<SeedanceVideoConfig, 'provider' | 'baseUrl' | 'apiKey' | 'model'>

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com'
const DEFAULT_MODEL = 'doubao-seedance-2-0-260128'
const DEFAULT_POLL_INTERVAL_MS = 15_000
const DEFAULT_TIMEOUT_MS = 900_000

async function appendVideoLog(cwd: string, line: string): Promise<void> {
  try {
    await mkdir(join(cwd, '.infiniti-agent'), { recursive: true })
    await appendFile(join(cwd, '.infiniti-agent', 'seedance-video.log'), `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    /* diagnostics must not break generation */
  }
}

function pickFirstNonEmpty(...vals: Array<string | undefined | null>): string {
  for (const v of vals) {
    const t = (v ?? '').trim()
    if (t) return t
  }
  return ''
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function resolveSeedanceConfig(cfg: InfinitiConfig): ResolvedSeedanceConfig {
  const s = cfg.seedance ?? {}
  const apiKey = pickFirstNonEmpty(
    s.apiKey,
    process.env.INFINITI_SEEDANCE_API_KEY,
    process.env.ARK_API_KEY,
    process.env.VOLCENGINE_API_KEY,
  )
  if (!apiKey) {
    throw new Error('缺少 Seedance API Key：请在 seedance.apiKey、INFINITI_SEEDANCE_API_KEY、ARK_API_KEY 或 VOLCENGINE_API_KEY 中配置')
  }
  return {
    provider: 'volcengine',
    baseUrl: s.baseUrl?.trim() || DEFAULT_BASE_URL,
    apiKey,
    model: s.model?.trim() || DEFAULT_MODEL,
    ratio: s.ratio?.trim() || '16:9',
    duration: s.duration ?? 5,
    ...(s.resolution?.trim() ? { resolution: s.resolution.trim() } : {}),
    generateAudio: s.generateAudio ?? true,
    watermark: s.watermark ?? false,
    ...(s.referenceImageUrls?.length ? { referenceImageUrls: s.referenceImageUrls } : {}),
    ...(s.referenceVideoUrls?.length ? { referenceVideoUrls: s.referenceVideoUrls } : {}),
    ...(s.referenceAudioUrls?.length ? { referenceAudioUrls: s.referenceAudioUrls } : {}),
    pollIntervalMs: s.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    timeoutMs: s.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
}

function tasksUrl(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, '')
  if (b.endsWith('/contents/generations/tasks')) return b
  if (b.endsWith('/api/v3')) return `${b}/contents/generations/tasks`
  return `${b}/api/v3/contents/generations/tasks`
}

function formatHttpError(prefix: string, res: Response, body: string): Error {
  return new Error(`${prefix} HTTP ${res.status}: ${body.slice(0, 800)}`)
}

async function readJsonResponse(url: string, init: RequestInit, prefix: string): Promise<unknown> {
  const res = await fetch(url, init)
  const body = await res.text()
  if (!res.ok) throw formatHttpError(prefix, res, body)
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new Error(`${prefix}: 响应不是 JSON: ${body.slice(0, 300)}`)
  }
}

function getString(obj: unknown, key: string): string {
  if (!obj || typeof obj !== 'object') return ''
  const v = (obj as Record<string, unknown>)[key]
  return typeof v === 'string' ? v.trim() : ''
}

function extractTaskId(json: unknown): string {
  const direct = getString(json, 'id') || getString(json, 'task_id')
  if (direct) return direct
  if (json && typeof json === 'object') {
    const data = (json as Record<string, unknown>).data
    const nested = getString(data, 'id') || getString(data, 'task_id')
    if (nested) return nested
  }
  throw new Error('Seedance 创建任务响应缺少 id')
}

function extractError(json: unknown): string {
  if (!json || typeof json !== 'object') return ''
  const o = json as Record<string, unknown>
  const direct = getString(o, 'message') || getString(o, 'error_message')
  if (direct) return direct
  const err = o.error
  if (typeof err === 'string') return err
  if (err && typeof err === 'object') {
    return getString(err, 'message') || JSON.stringify(err)
  }
  return ''
}

function extractVideoUrl(json: unknown): string {
  if (!json || typeof json !== 'object') return ''
  const o = json as Record<string, unknown>
  const content = o.content
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>
    const direct = getString(c, 'video_url') || getString(c, 'url')
    if (direct) return direct
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== 'object') continue
      const it = item as Record<string, unknown>
      const direct = getString(it, 'url')
      if (direct) return direct
      const video = it.video_url
      if (video && typeof video === 'object') {
        const nested = getString(video, 'url')
        if (nested) return nested
      }
    }
  }
  const data = o.data
  if (data && typeof data === 'object') return extractVideoUrl(data)
  return ''
}

function extFromUrl(url: string): string {
  const pathname = (() => {
    try {
      return new URL(url).pathname
    } catch {
      return url
    }
  })()
  const e = extname(pathname).toLowerCase()
  if (e === '.mp4' || e === '.webm' || e === '.mov') return e.slice(1)
  return 'mp4'
}

function buildContent(prompt: string, auth: ResolvedSeedanceConfig, referenceImages: SeedanceReferenceImage[]): unknown[] {
  const content: unknown[] = []
  for (const image of referenceImages) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:${image.mediaType};base64,${image.base64}` },
      role: 'reference_image',
    })
  }
  content.push({ type: 'text', text: prompt.trim() })
  for (const url of auth.referenceImageUrls ?? []) {
    content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
  }
  for (const url of auth.referenceVideoUrls ?? []) {
    content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' })
  }
  for (const url of auth.referenceAudioUrls ?? []) {
    content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' })
  }
  return content
}

async function createTask(cwd: string, auth: ResolvedSeedanceConfig, prompt: string, referenceImages: SeedanceReferenceImage[]): Promise<string> {
  const url = tasksUrl(auth.baseUrl)
  const body = {
    model: auth.model,
    content: buildContent(prompt, auth, referenceImages),
    ratio: auth.ratio,
    duration: auth.duration,
    ...(auth.resolution ? { resolution: auth.resolution } : {}),
    generate_audio: auth.generateAudio,
    watermark: auth.watermark,
  }
  await appendVideoLog(cwd, `create model=${auth.model} ratio=${auth.ratio} duration=${auth.duration} imageRefs=${referenceImages.length} endpoint=${url}`)
  const json = await readJsonResponse(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.apiKey}`,
    },
    body: JSON.stringify(body),
  }, 'Seedance 创建任务失败')
  return extractTaskId(json)
}

async function pollTask(cwd: string, auth: ResolvedSeedanceConfig, taskId: string): Promise<unknown> {
  const url = `${tasksUrl(auth.baseUrl)}/${encodeURIComponent(taskId)}`
  const deadline = Date.now() + (auth.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  for (;;) {
    const json = await readJsonResponse(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${auth.apiKey}` },
    }, 'Seedance 查询任务失败')
    const status = getString(json, 'status') || getString((json as { data?: unknown }).data, 'status')
    await appendVideoLog(cwd, `poll task=${taskId} status=${status || 'unknown'}`)
    if (status === 'succeeded') return json
    if (status === 'failed' || status === 'cancelled' || status === 'expired') {
      throw new Error(`Seedance 任务${status}: ${extractError(json) || '无详细错误'}`)
    }
    if (Date.now() >= deadline) {
      throw new Error(`Seedance 任务超时：${taskId}`)
    }
    await sleep(auth.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
  }
}

async function downloadVideo(cwd: string, videoUrl: string): Promise<{ path: string; bytes: number }> {
  const res = await fetch(videoUrl)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw formatHttpError('Seedance 视频下载失败', res, body)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  const outDir = join(localInboxDir(cwd), 'assets')
  await mkdir(outDir, { recursive: true })
  const ext = extFromUrl(videoUrl)
  const path = join(outDir, `infiniti-agent-seedance-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.${ext}`)
  await writeFile(path, buf)
  return { path, bytes: buf.length }
}

export async function generateSeedanceVideo(
  cwd: string,
  cfg: InfinitiConfig,
  userPrompt: string,
  referenceImages: SeedanceReferenceImage[] = [],
): Promise<SeedanceVideoResult> {
  const prompt = userPrompt.trim()
  if (!prompt) throw new Error('/video 后请输入提示词，例如：/video 夕阳海边的电影感航拍，慢速推进')
  const auth = resolveSeedanceConfig(cfg)
  const taskId = await createTask(cwd, auth, prompt, referenceImages)
  const result = await pollTask(cwd, auth, taskId)
  const videoUrl = extractVideoUrl(result)
  if (!videoUrl) throw new Error(`Seedance 任务成功但响应缺少 video_url：${taskId}`)
  const downloaded = await downloadVideo(cwd, videoUrl)
  await appendVideoLog(cwd, `ok task=${taskId} path=${downloaded.path} bytes=${downloaded.bytes}`)
  return {
    path: downloaded.path,
    provider: auth.provider,
    model: auth.model,
    taskId,
    videoUrl,
    bytes: downloaded.bytes,
    status: 'succeeded',
    ...(auth.ratio ? { ratio: auth.ratio } : {}),
    ...(auth.duration ? { duration: auth.duration } : {}),
    ...(auth.resolution ? { resolution: auth.resolution } : {}),
  }
}
