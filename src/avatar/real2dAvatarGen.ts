import OpenAI, { toFile } from 'openai'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import type { InfinitiConfig } from '../config/types.js'
import { resolveLlmProfile } from '../config/types.js'
import type { LiveUiFileAttachment, LiveUiVisionAttachment } from '../liveui/protocol.js'
import { localInboxDir } from '../paths.js'
import { transparentizeStudioBackgroundPng } from './transparentizePngBackground.js'

export type AvatarGenReferenceImage = {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
  base64: string
  label?: string
}

export type Real2dAvatarGenResult = {
  dir: string
  files: Array<{ name: string; path: string; bytes: number; hasAlpha: boolean }>
  provider: 'chatgpt-image'
  model: 'gpt-image-2'
}

type AvatarGenAuth = {
  provider: 'chatgpt-image'
  baseUrl: string
  apiKey: string
  model: 'gpt-image-2'
  imageSize?: string
}

const DEFAULT_OPENAI_IMAGE_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_GPT_IMAGE_MODEL = 'gpt-image-2'
const DEFAULT_TIMEOUT_MS = 120_000

const TARGETS = [
  {
    name: 'exp01.png',
    label: 'neutral',
    prompt: 'neutral calm expression, relaxed eyes, natural gaze, mouth closed, subtle relaxed lips, no strong emotion',
  },
  {
    name: 'exp02.png',
    label: 'happy',
    prompt: 'happy cheerful expression, bright smile, smiling eyes, lifted cheeks, warm friendly look, same pose and framing',
  },
  {
    name: 'exp03.png',
    label: 'sad',
    prompt: 'sad melancholy expression, downturned mouth corners, sad eyebrows raised at the inner ends, soft droopy eyes, quiet sorrowful look, no tears',
  },
  {
    name: 'exp04.png',
    label: 'angry',
    prompt: 'angry expression, furrowed brows pointing downward toward the center, intense gaze, frowning or tight pressed lips, serious tense face',
  },
  {
    name: 'exp05.png',
    label: 'surprised',
    prompt: 'surprised expression, wide open eyes, eyebrows raised high, small open mouth or rounded surprised lips, alert startled look',
  },
  {
    name: 'exp06.png',
    label: 'eyes_closed',
    prompt: 'eyes closed peacefully, relaxed expression, mouth closed, calm serene face, soft relaxed eyebrows, gentle peaceful mood',
  },
  {
    name: 'exp_open.png',
    label: 'talk_open',
    prompt: 'natural speaking open mouth, jaw slightly lowered, lips parted in a clear talking shape, teeth slightly visible if natural, eyes open, otherwise neutral calm face',
  },
] as const

function pickFirstNonEmpty(...vals: Array<string | undefined | null>): string {
  for (const v of vals) {
    const t = (v ?? '').trim()
    if (t) return t
  }
  return ''
}

async function appendAvatarGenLog(cwd: string, line: string): Promise<void> {
  try {
    await mkdir(join(cwd, '.infiniti-agent'), { recursive: true })
    await appendFile(join(cwd, '.infiniti-agent', 'avatargen.log'), `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    /* diagnostics only */
  }
}

export function resolveReal2dAvatarGenAuth(cfg: InfinitiConfig): AvatarGenAuth {
  const ag = cfg.avatarGen
  const envModel = process.env.INFINITI_AVATAR_GEN_MODEL?.trim()
  const provider = ag?.provider
  const model = pickFirstNonEmpty(ag?.model, envModel, provider === 'chatgpt-image' ? DEFAULT_GPT_IMAGE_MODEL : undefined)

  if (provider !== 'chatgpt-image' || model !== DEFAULT_GPT_IMAGE_MODEL) {
    throw new Error(
      '当前 AvatarGen 不是 GPT-Image2 设置，real2d 表情集生成暂时不能使用。请把 avatarGen.provider 设为 chatgpt-image，并把 avatarGen.model 设为 gpt-image-2。',
    )
  }

  const prof = resolveLlmProfile(cfg)
  const apiKey = pickFirstNonEmpty(
    ag?.apiKey,
    process.env.INFINITI_OPENAI_IMAGE_API_KEY,
    process.env.OPENAI_API_KEY,
    prof.provider === 'openai' ? prof.apiKey : undefined,
    cfg.llm.provider === 'openai' ? cfg.llm.apiKey : undefined,
  )
  if (!apiKey) {
    throw new Error('缺少 OpenAI 图像 API Key：请在 avatarGen.apiKey、INFINITI_OPENAI_IMAGE_API_KEY 或 OPENAI_API_KEY 中配置')
  }

  return {
    provider: 'chatgpt-image',
    baseUrl: ag?.baseUrl?.trim() || DEFAULT_OPENAI_IMAGE_BASE_URL,
    apiKey,
    model: DEFAULT_GPT_IMAGE_MODEL,
    ...(ag?.imageSize?.trim() ? { imageSize: ag.imageSize.trim() } : {}),
  }
}

export function avatarGenReferenceImagesFromLiveInputs(
  vision?: LiveUiVisionAttachment,
  attachments: LiveUiFileAttachment[] = [],
): AvatarGenReferenceImage[] {
  const out: AvatarGenReferenceImage[] = []
  if (vision) {
    out.push({
      mediaType: vision.mediaType,
      base64: vision.imageBase64,
      label: 'camera snapshot',
    })
  }
  for (const a of attachments) {
    if (
      a.kind !== 'image' ||
      (a.mediaType !== 'image/jpeg' && a.mediaType !== 'image/png' && a.mediaType !== 'image/webp')
    ) {
      continue
    }
    out.push({
      mediaType: a.mediaType,
      base64: a.base64,
      label: a.name,
    })
  }
  return out.slice(0, 4)
}

function buildPrompt(userPrompt: string, target: typeof TARGETS[number], hasReference: boolean): string {
  const extra = userPrompt.trim()
  const referenceRules = hasReference
    ? [
        'Using the provided transparent-background PNG avatar as the reference image, preserve the exact same character identity, hairstyle, outfit, body pose, camera angle, lighting, crop, scale, and transparent background.',
        '',
        'Modify only the facial expression or mouth shape according to the target description below.',
      ]
    : [
        'Generate one front-facing transparent-background PNG avatar sprite from the user instruction below.',
        'Create a centered upper-body or bust portrait suitable for a Real2D avatar sprite.',
        'Use a consistent character identity, hairstyle, outfit, body pose, camera angle, lighting, crop, and scale that can be reused for all expression variants.',
      ]

  return [
    ...referenceRules,
    '',
    'The output must be a PNG with a true alpha-transparent background. Do not create a white, black, gray, gradient, studio, or checkerboard background. Do not add props, text, shadows, scenery, borders, or extra objects. Keep the character centered and consistent.',
    '',
    `Target file: ${target.name}`,
    `Target expression: ${target.prompt}`,
    extra ? `User instruction: ${extra}` : '',
  ].filter(Boolean).join('\n')
}

async function imageHasAlpha(buf: Buffer): Promise<boolean> {
  try {
    return Boolean((await sharp(buf).metadata()).hasAlpha)
  } catch {
    return false
  }
}

async function ensureTransparentBackground(cwd: string, name: string, buf: Buffer): Promise<{ buffer: Buffer; hasAlpha: boolean; transparentized: boolean }> {
  const hasAlpha = await imageHasAlpha(buf)
  if (hasAlpha) return { buffer: buf, hasAlpha, transparentized: false }
  try {
    const out = await transparentizeStudioBackgroundPng(buf)
    const outHasAlpha = await imageHasAlpha(out)
    await appendAvatarGenLog(cwd, `transparentized ${name} alpha=${outHasAlpha}`)
    return { buffer: out, hasAlpha: outHasAlpha, transparentized: true }
  } catch (e) {
    await appendAvatarGenLog(cwd, `transparentize_failed ${name} error=${(e as Error).message}`)
    return { buffer: buf, hasAlpha: false, transparentized: false }
  }
}

async function generateOne(
  client: OpenAI,
  auth: AvatarGenAuth,
  refs: AvatarGenReferenceImage[],
  prompt: string,
): Promise<Buffer> {
  const resp = await client.images.edit({
    model: auth.model,
    prompt,
    n: 1,
    size: auth.imageSize ?? '1024x1536',
    output_format: 'png',
    image: await Promise.all(
      refs.map((r, idx) =>
        toFile(Buffer.from(r.base64, 'base64'), `real2d-ref-${idx}.${r.mediaType.split('/')[1] ?? 'png'}`, { type: r.mediaType }),
      ),
    ),
    input_fidelity: 'high',
  } as never, { timeout: DEFAULT_TIMEOUT_MS })

  const first = (resp as { data?: Array<{ b64_json?: string; url?: string }> }).data?.[0]
  if (!first) throw new Error('OpenAI 图像响应为空')
  if (first.b64_json) return Buffer.from(first.b64_json, 'base64')
  if (first.url) {
    const dataUrl = first.url.trim().match(/^data:[^;]+;base64,(.+)$/is)
    if (dataUrl) return Buffer.from(dataUrl[1]!, 'base64')
    const res = await fetch(first.url)
    if (!res.ok) throw new Error(`OpenAI 图像 URL 下载失败: HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }
  throw new Error('OpenAI 图像响应没有 b64_json 或 url')
}

async function generateBaseWithoutReference(
  client: OpenAI,
  auth: AvatarGenAuth,
  prompt: string,
): Promise<Buffer> {
  const resp = await client.images.generate({
    model: auth.model,
    prompt,
    n: 1,
    size: auth.imageSize ?? '1024x1536',
    output_format: 'png',
  } as never, { timeout: DEFAULT_TIMEOUT_MS })

  const first = (resp as { data?: Array<{ b64_json?: string; url?: string }> }).data?.[0]
  if (!first) throw new Error('OpenAI 图像响应为空')
  if (first.b64_json) return Buffer.from(first.b64_json, 'base64')
  if (first.url) {
    const dataUrl = first.url.trim().match(/^data:[^;]+;base64,(.+)$/is)
    if (dataUrl) return Buffer.from(dataUrl[1]!, 'base64')
    const res = await fetch(first.url)
    if (!res.ok) throw new Error(`OpenAI 图像 URL 下载失败: HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }
  throw new Error('OpenAI 图像响应没有 b64_json 或 url')
}

export async function generateReal2dAvatarSet(
  cwd: string,
  cfg: InfinitiConfig,
  userPrompt: string,
  referenceImages: AvatarGenReferenceImage[],
): Promise<Real2dAvatarGenResult> {
  const auth = resolveReal2dAvatarGenAuth(cfg)

  const outDir = join(
    localInboxDir(cwd),
    'assets',
    `infiniti-agent-avatargen-real2d-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
  )
  await mkdir(outDir, { recursive: true })
  await appendAvatarGenLog(cwd, `start model=${auth.model} refs=${referenceImages.length} out=${outDir}`)

  const client = new OpenAI({ apiKey: auth.apiKey, baseURL: auth.baseUrl, timeout: DEFAULT_TIMEOUT_MS })
  const files: Real2dAvatarGenResult['files'] = []
  let refs = referenceImages
  for (const target of TARGETS) {
    const prompt = buildPrompt(userPrompt, target, refs.length > 0)
    const rawBuf = refs.length
      ? await generateOne(client, auth, refs, prompt)
      : await generateBaseWithoutReference(client, auth, prompt)
    const { buffer: buf, hasAlpha, transparentized } = await ensureTransparentBackground(cwd, target.name, rawBuf)
    const dest = join(outDir, target.name)
    await writeFile(dest, buf)
    files.push({ name: target.name, path: dest, bytes: buf.length, hasAlpha })
    await appendAvatarGenLog(cwd, `wrote ${target.name} bytes=${buf.length} alpha=${hasAlpha} transparentized=${transparentized}`)
    if (!referenceImages.length && target.name === 'exp01.png') {
      refs = [{ mediaType: 'image/png', base64: buf.toString('base64'), label: 'generated exp01 base' }]
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  await appendAvatarGenLog(cwd, `ok out=${outDir}`)
  return { dir: outDir, files, provider: 'chatgpt-image', model: DEFAULT_GPT_IMAGE_MODEL }
}
