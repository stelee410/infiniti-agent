import OpenAI, { toFile } from 'openai'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { InfinitiConfig, SnapImageConfig } from '../config/types.js'
import { resolveLlmProfile } from '../config/types.js'
import type { LiveUiVisionAttachment } from '../liveui/protocol.js'
import { openRouterGenerateImageBuffer, type OpenRouterRefImage } from '../avatar/openRouterImageGen.js'

type RefImage = {
  role: 'user' | 'agent'
  mimeType: string
  buffer: Buffer
}

export type SnapGenerateResult = {
  path: string
  provider: 'nano-banana' | 'gpt-image-2'
  model: string
  bytes: number
  usedUserPhoto: boolean
  usedAgentReference: boolean
}

const DEFAULT_OPENROUTER = 'https://openrouter.ai/api/v1'
const DEFAULT_NANO_BANANA_MODEL = 'google/gemini-3-pro-image-preview'
const DEFAULT_OPENAI_IMAGE_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_GPT_IMAGE_MODEL = 'gpt-image-2'
const DEFAULT_TIMEOUT_MS = 120_000

async function appendSnapLog(cwd: string, line: string): Promise<void> {
  try {
    await mkdir(join(cwd, '.infiniti-agent'), { recursive: true })
    await appendFile(join(cwd, '.infiniti-agent', 'snap.log'), `${new Date().toISOString()} ${line}\n`, 'utf8')
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

function mimeForPath(p: string): 'image/jpeg' | 'image/png' | 'image/webp' | 'application/octet-stream' {
  const e = extname(p).toLowerCase()
  if (e === '.png') return 'image/png'
  if (e === '.webp') return 'image/webp'
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg'
  return 'application/octet-stream'
}

function imageExt(buf: Buffer): 'png' | 'jpg' | 'webp' {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png'
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp'
  }
  return 'png'
}

function dataUrlToBuffer(dataUrl: string): Buffer | null {
  const m = dataUrl.trim().match(/^data:[^;]+;base64,(.+)$/is)
  return m ? Buffer.from(m[1]!, 'base64') : null
}

async function firstExistingImage(dir: string): Promise<string | null> {
  if (!existsSync(dir)) return null
  const names = await readdir(dir).catch(() => [])
  const preferred = [
    'exp_01.png',
    'neutral.png',
    'half_body.png',
    'avatar.png',
  ]
  for (const name of preferred) {
    const p = join(dir, name)
    if (existsSync(p)) return p
  }
  const hit = names.find((n) => /\.(png|jpe?g|webp)$/i.test(n))
  return hit ? join(dir, hit) : null
}

async function loadAgentReference(cwd: string, cfg: InfinitiConfig): Promise<RefImage | null> {
  const dirRaw = cfg.liveUi?.spriteExpressions?.dir?.trim()
  if (!dirRaw) return null
  const dir = resolve(cwd, dirRaw)
  const p = await firstExistingImage(dir)
  if (!p) return null
  const mimeType = mimeForPath(p)
  if (mimeType === 'application/octet-stream') return null
  return { role: 'agent', mimeType, buffer: await readFile(p) }
}

function userVisionToRef(vision?: LiveUiVisionAttachment): RefImage | null {
  if (!vision) return null
  return {
    role: 'user',
    mimeType: vision.mediaType,
    buffer: Buffer.from(vision.imageBase64, 'base64'),
  }
}

function resolveSnapConfig(cfg: InfinitiConfig): Required<Pick<SnapImageConfig, 'provider' | 'baseUrl' | 'model'>> &
  Omit<SnapImageConfig, 'provider' | 'baseUrl' | 'model'> & { apiKey: string } {
  const snap = cfg.snap ?? {}
  const provider = snap.provider ?? 'nano-banana'
  const prof = resolveLlmProfile(cfg)

  if (provider === 'gpt-image-2') {
    const apiKey = pickFirstNonEmpty(
      snap.apiKey,
      process.env.INFINITI_OPENAI_IMAGE_API_KEY,
      process.env.OPENAI_API_KEY,
      prof.provider === 'openai' ? prof.apiKey : undefined,
      cfg.llm.provider === 'openai' ? cfg.llm.apiKey : undefined,
    )
    if (!apiKey) throw new Error('缺少 OpenAI 图像 API Key：请在 snap.apiKey 或 OPENAI_API_KEY 中配置')
    return {
      provider,
      baseUrl: snap.baseUrl?.trim() || DEFAULT_OPENAI_IMAGE_BASE_URL,
      apiKey,
      model: snap.model?.trim() || DEFAULT_GPT_IMAGE_MODEL,
      ...(snap.imageSize?.trim() ? { imageSize: snap.imageSize.trim() } : { imageSize: '1024x1024' }),
      ...(snap.quality ? { quality: snap.quality } : { quality: 'auto' }),
      ...(snap.aspectRatio?.trim() ? { aspectRatio: snap.aspectRatio.trim() } : {}),
      timeoutMs: snap.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    }
  }

  const apiKey = pickFirstNonEmpty(
    snap.apiKey,
    process.env.INFINITI_OPENROUTER_API_KEY,
    process.env.OPENROUTER_API_KEY,
    prof.provider === 'openrouter' ? prof.apiKey : undefined,
    cfg.llm.provider === 'openrouter' ? cfg.llm.apiKey : undefined,
  )
  if (!apiKey) throw new Error('缺少 OpenRouter API Key：请在 snap.apiKey、OPENROUTER_API_KEY 或 OpenRouter LLM profile 中配置')
  return {
    provider,
    baseUrl: snap.baseUrl?.trim() || DEFAULT_OPENROUTER,
    apiKey,
    model: snap.model?.trim() || DEFAULT_NANO_BANANA_MODEL,
    ...(snap.aspectRatio?.trim() ? { aspectRatio: snap.aspectRatio.trim() } : { aspectRatio: '4:3' }),
    ...(snap.imageSize?.trim() ? { imageSize: snap.imageSize.trim() } : {}),
    ...(snap.quality ? { quality: snap.quality } : {}),
    timeoutMs: snap.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
}

function buildSnapPrompt(userPrompt: string, refs: RefImage[]): string {
  const hasUser = refs.some((r) => r.role === 'user')
  const hasAgent = refs.some((r) => r.role === 'agent')
  const base =
    hasUser && hasAgent
      ? 'Create a photorealistic shared photo of the real user in the user reference image and the agent character in the agent reference image. Transform the agent reference into a lifelike human while preserving recognizable outfit, hairstyle, mood, and character design cues. Preserve the user identity from the photo. Make it look like a natural camera photo, not an illustration.'
      : hasUser
        ? 'Create a photorealistic shared photo featuring the real user from the reference image and a lifelike agent companion designed from the prompt. Preserve the user identity. Make it look like a natural camera photo, not an illustration.'
        : hasAgent
          ? 'Create a photorealistic photo based on the prompt. Transform the agent reference image into a lifelike human while preserving recognizable outfit, hairstyle, mood, and character design cues. Make it look like a natural camera photo, not an illustration.'
          : 'Create a photorealistic, lifelike camera photo based on the prompt. Avoid illustration, anime, CGI, and over-polished stock-photo styling.'

  return `${base}\n\nUser prompt: ${userPrompt.trim()}`
}

async function generateWithOpenRouter(auth: ReturnType<typeof resolveSnapConfig>, prompt: string, refs: RefImage[]): Promise<Buffer> {
  const referenceImages: OpenRouterRefImage[] = refs.map((r) => ({
    mimeType: r.mimeType,
    base64: r.buffer.toString('base64'),
  }))
  return await openRouterGenerateImageBuffer({
    baseUrl: auth.baseUrl,
    apiKey: auth.apiKey,
    model: auth.model,
    prompt,
    referenceImages,
    modalities: ['image', 'text'],
    ...(auth.aspectRatio ? { aspectRatio: auth.aspectRatio } : {}),
    ...(auth.imageSize ? { imageSize: auth.imageSize } : {}),
    timeoutMs: auth.timeoutMs,
  })
}

async function generateWithOpenAI(auth: ReturnType<typeof resolveSnapConfig>, prompt: string, refs: RefImage[]): Promise<Buffer> {
  const client = new OpenAI({ apiKey: auth.apiKey, baseURL: auth.baseUrl, timeout: auth.timeoutMs })
  const common = {
    model: auth.model,
    prompt,
    n: 1,
    ...(auth.imageSize ? { size: auth.imageSize } : {}),
    ...(auth.quality ? { quality: auth.quality } : {}),
    output_format: 'png',
  }
  const resp = refs.length
      ? await client.images.edit({
        ...common,
        image: await Promise.all(
          refs.map((r, idx) =>
            toFile(r.buffer, `${r.role}-${idx}.${r.mimeType.split('/')[1] ?? 'png'}`, { type: r.mimeType }),
          ),
        ),
        input_fidelity: 'high',
      } as never, { timeout: auth.timeoutMs })
    : await client.images.generate(common as never, { timeout: auth.timeoutMs })

  const first = (resp as { data?: Array<{ b64_json?: string; url?: string }> }).data?.[0]
  if (!first) throw new Error('OpenAI 图像响应为空')
  if (first.b64_json) return Buffer.from(first.b64_json, 'base64')
  if (first.url) {
    const dataUrl = dataUrlToBuffer(first.url)
    if (dataUrl) return dataUrl
    const res = await fetch(first.url)
    if (!res.ok) throw new Error(`OpenAI 图像 URL 下载失败: HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }
  throw new Error('OpenAI 图像响应没有 b64_json 或 url')
}

export async function generateSnapPhoto(
  cwd: string,
  cfg: InfinitiConfig,
  userPrompt: string,
  userVision?: LiveUiVisionAttachment,
): Promise<SnapGenerateResult> {
  const promptText = userPrompt.trim()
  if (!promptText) throw new Error('/snap 后请输入提示词，例如：/snap 在咖啡馆自拍，暖色灯光')

  const auth = resolveSnapConfig(cfg)
  const refs = [userVisionToRef(userVision), await loadAgentReference(cwd, cfg)].filter((x): x is RefImage => x != null)
  const prompt = buildSnapPrompt(promptText, refs)
  await appendSnapLog(
    cwd,
    `start provider=${auth.provider} model=${auth.model} refs=${refs.map((r) => r.role).join(',') || 'none'} timeoutMs=${auth.timeoutMs}`,
  )
  let image: Buffer
  try {
    image =
      auth.provider === 'gpt-image-2'
        ? await generateWithOpenAI(auth, prompt, refs)
        : await generateWithOpenRouter(auth, prompt, refs)
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    await appendSnapLog(cwd, `failed ${msg}`)
    throw e
  }

  const ext = imageExt(image)
  const path = join(tmpdir(), `infiniti-agent-snap-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.${ext}`)
  await mkdir(tmpdir(), { recursive: true })
  await writeFile(path, image)
  await appendSnapLog(cwd, `ok path=${path} bytes=${image.length}`)
  return {
    path,
    provider: auth.provider,
    model: auth.model,
    bytes: image.length,
    usedUserPhoto: refs.some((r) => r.role === 'user'),
    usedAgentReference: refs.some((r) => r.role === 'agent'),
  }
}
