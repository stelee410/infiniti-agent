import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import type { InfinitiConfig } from '../config/types.js'
import { resolveLlmProfile } from '../config/types.js'
import { getInfinitiConfigPath, loadConfig } from '../config/io.js'
import { localLinkyunRefDir } from '../paths.js'
import { openRouterGenerateImageBuffer } from '../avatar/openRouterImageGen.js'
import { transparentizeStudioBackgroundPng } from '../avatar/transparentizePngBackground.js'
import {
  defaultLunaStyleManifest,
  type SpriteExpressionManifestV1,
} from '../liveui/spriteExpressionManifest.js'

const DEFAULT_OPENROUTER = 'https://openrouter.ai/api/v1'
/** OpenRouter：Nano Banana Pro（Gemini 3 Pro Image Preview），强于 2.5 Flash Image */
const DEFAULT_IMAGE_MODEL = 'google/gemini-3-pro-image-preview'

function mimeForPath(p: string): string {
  const e = extname(p).toLowerCase()
  if (e === '.png') return 'image/png'
  if (e === '.webp') return 'image/webp'
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg'
  return 'application/octet-stream'
}

async function findAvatarInRef(refDir: string): Promise<string | null> {
  if (!existsSync(refDir)) return null
  const names = await readdir(refDir)
  const hit = names.find((n) => /^avatar\./i.test(n))
  return hit ? join(refDir, hit) : null
}

async function findCharacterSheetInRef(refDir: string): Promise<string | null> {
  if (!existsSync(refDir)) return null
  const names = await readdir(refDir)
  const hit = names.find((n) => /^sheet_\d+\.(png|jpe?g|webp)$/i.test(n))
  return hit ? join(refDir, hit) : null
}

async function readSpecExcerpt(refDir: string, maxChars: number): Promise<string> {
  const p = join(refDir, 'character_design_spec.md')
  if (!existsSync(p)) return ''
  try {
    const t = await readFile(p, 'utf8')
    return t.trim().slice(0, maxChars)
  } catch {
    return ''
  }
}

/**
 * 图像 API 无流式进度时，在 stderr 同一行刷新「已等待 Ns」。
 */
async function withElapsedProgress<T>(detail: string, run: () => Promise<T>): Promise<T> {
  let sec = 0
  const paint = () => {
    process.stderr.write(`\r\x1b[K[generate_avatar] ${detail} … ${sec}s`)
  }
  paint()
  const id = setInterval(() => {
    sec += 1
    paint()
  }, 1000)
  try {
    return await run()
  } finally {
    clearInterval(id)
    process.stderr.write('\r\x1b[K')
  }
}

function pickFirstNonEmpty(...vals: Array<string | undefined | null>): string {
  for (const v of vals) {
    const t = (v ?? '').trim()
    if (t) return t
  }
  return ''
}

function resolveAvatarGenAuth(cfg: InfinitiConfig): { baseUrl: string; apiKey: string; model: string; aspectRatio?: string; imageSize?: string } {
  const ag = cfg.avatarGen
  const prof = resolveLlmProfile(cfg)
  const apiKey = pickFirstNonEmpty(
    ag?.apiKey,
    process.env.INFINITI_OPENROUTER_API_KEY,
    process.env.OPENROUTER_API_KEY,
    prof.apiKey,
    cfg.llm.apiKey,
  )
  if (!apiKey) {
    throw new Error(
      '缺少 OpenRouter API Key（会出现 Missing Authentication header）。请任选其一：\n' +
        '  1) 在 .infiniti-agent/config.json 增加 "avatarGen": { "apiKey": "sk-or-v1-..." }\n' +
        '  2) 保证 llm 默认 profile 的 apiKey 为 OpenRouter 的 sk-or-v1-…\n' +
        '  3) 环境变量 INFINITI_OPENROUTER_API_KEY 或 OPENROUTER_API_KEY',
    )
  }
  const baseUrl = (ag?.baseUrl ?? DEFAULT_OPENROUTER).trim()
  const envModel = process.env.INFINITI_AVATAR_GEN_MODEL?.trim()
  const model = pickFirstNonEmpty(ag?.model, envModel, DEFAULT_IMAGE_MODEL)
  return {
    baseUrl,
    apiKey,
    model,
    ...(ag?.aspectRatio?.trim() ? { aspectRatio: ag.aspectRatio.trim() } : {}),
    ...(ag?.imageSize?.trim() ? { imageSize: ag.imageSize.trim() } : {}),
  }
}

/** 各 exp 的绘画面部描述（英文，便于图像模型理解） */
function expressionVisualPrompt(entry: SpriteExpressionManifestV1['entries'][0]): string {
  const id = entry.id
  const presets: Record<string, string> = {
    exp_01: 'neutral calm expression, relaxed eyes, subtle closed-mouth smile',
    exp_02: 'sad tearful eyes, downturned mouth, melancholic',
    exp_03: 'bright happy smile, cheerful eyes, energetic',
    exp_04: 'smug smirk or playful blush cheeks, subtle mischief',
    exp_05: 'thinking pose, finger near chin or thoughtful gaze upward',
    exp_06: 'angry furrowed brows, sharp eyes, tense mouth',
    exp_07: 'surprised wide eyes, open mouth soft O shape',
    exp_08: 'slight frown, concerned or displeased look',
  }
  return presets[id] ?? `${entry.label ?? id} facial expression, clear readable emotion, anime illustration`
}

export type GenerateAvatarOptions = {
  /** LinkYun sync 后的 agent code，如 jess */
  agent: string
  /** 输出表情目录，默认 live2d-models/<agent>/expression */
  outDir?: string
  /** 跳过半身像步骤（复用目录内已有 half_body.png） */
  skipHalfBody?: boolean
  /** 为 true 时跳过「边缘连通背景 → 透明」后处理 */
  noTransparentize?: boolean
}

function parseBgToleranceFromEnv(): number | undefined {
  const s = process.env.INFINITI_AVATAR_BG_TOLERANCE?.trim()
  if (!s) return undefined
  const n = Number(s)
  if (!Number.isFinite(n)) return undefined
  return n
}

export async function runGenerateAvatar(cwd: string, opts: GenerateAvatarOptions): Promise<void> {
  const agent = opts.agent.trim().toLowerCase()
  if (!agent) {
    console.error('--agent 不能为空')
    process.exitCode = 2
    return
  }

  const cfgPath = getInfinitiConfigPath(cwd)
  const cfg = await loadConfig(cwd)
  const auth = resolveAvatarGenAuth(cfg)
  console.error(`[generate_avatar] 配置: ${cfgPath}`)
  console.error(`[generate_avatar] 模型: ${auth.model}`)
  if (process.env.INFINITI_AVATAR_GEN_MODEL?.trim() && !cfg.avatarGen?.model?.trim()) {
    console.error('[generate_avatar] 提示: 模型由环境变量 INFINITI_AVATAR_GEN_MODEL 覆盖；若需改用 config 请 unset 该变量')
  }

  const refDir = localLinkyunRefDir(cwd, agent)
  const avatarPath = await findAvatarInRef(refDir)
  if (!avatarPath) {
    console.error(`未在 ${refDir} 找到头像文件（需 sync 后的 avatar.*）`)
    process.exitCode = 2
    return
  }

  const sheetPath = await findCharacterSheetInRef(refDir)
  const spec = await readSpecExcerpt(refDir, 4000)

  const outRoot = opts.outDir?.trim()
    ? resolve(cwd, opts.outDir.trim())
    : join(cwd, 'live2d-models', agent, 'expression')
  await mkdir(outRoot, { recursive: true })

  const avatarBuf = await readFile(avatarPath)
  const avatarB64 = avatarBuf.toString('base64')
  const avatarMime = mimeForPath(avatarPath)

  const refs: Array<{ mimeType: string; base64: string }> = [
    { mimeType: avatarMime, base64: avatarB64 },
  ]
  if (sheetPath) {
    const sb = await readFile(sheetPath)
    refs.push({ mimeType: mimeForPath(sheetPath), base64: sb.toString('base64') })
  }

  const halfBodyPath = join(outRoot, 'half_body.png')
  if (!opts.skipHalfBody || !existsSync(halfBodyPath)) {
    const specBlock = spec
      ? `\n\nCharacter design notes (may truncate):\n${spec}`
      : ''
    const halfPrompt =
      'Generate ONE anime-style half-body portrait (waist-up), same character identity as the reference face and outfit. ' +
      'Soft studio lighting, plain light gray background, high detail, single character centered. ' +
      'Preserve hairstyle, eye color, clothing from references.' +
      specBlock

    const halfBuf = await withElapsedProgress(`${auth.model} 生成半身像`, () =>
      openRouterGenerateImageBuffer({
        baseUrl: auth.baseUrl,
        apiKey: auth.apiKey,
        model: auth.model,
        prompt: halfPrompt,
        referenceImages: refs,
        modalities: ['image', 'text'],
        aspectRatio: auth.aspectRatio ?? '2:3',
        ...(auth.imageSize ? { imageSize: auth.imageSize } : {}),
      }),
    )
    await writeFile(halfBodyPath, halfBuf)
    console.error(`[generate_avatar] 已写入 ${halfBodyPath}`)
  } else {
    console.error(`[generate_avatar] 跳过半身像，使用已有 ${halfBodyPath}`)
  }

  const halfRead = await readFile(halfBodyPath)
  const halfMime =
    halfRead.length >= 8 &&
    halfRead[0] === 0x89 &&
    halfRead[1] === 0x50 &&
    halfRead[2] === 0x4e &&
    halfRead[3] === 0x47
      ? 'image/png'
      : halfRead[0] === 0xff && halfRead[1] === 0xd8
        ? 'image/jpeg'
        : 'image/png'
  const halfRef = [{ mimeType: halfMime, base64: halfRead.toString('base64') }]

  const manifest = defaultLunaStyleManifest()

  for (const ent of manifest.entries) {
    const vis = expressionVisualPrompt(ent)
    const prompt =
      `Generate ONE anime-style half-body portrait (waist-up), SAME character as reference image. ` +
      `Change ONLY facial expression: ${vis}. ` +
      `Keep same hairstyle, outfit, body pose, lighting and plain light gray background. ` +
      `Single character, high detail, no text, no watermark.`

    const buf = await withElapsedProgress(
      `${auth.model} 表情 ${ent.id} (${ent.label ?? ent.emotions[0]})`,
      () =>
        openRouterGenerateImageBuffer({
          baseUrl: auth.baseUrl,
          apiKey: auth.apiKey,
          model: auth.model,
          prompt,
          referenceImages: halfRef,
          modalities: ['image', 'text'],
          aspectRatio: auth.aspectRatio ?? '2:3',
          ...(auth.imageSize ? { imageSize: auth.imageSize } : {}),
        }),
    )
    const dest = join(outRoot, `${ent.id}.png`)
    await writeFile(dest, buf)
    console.error(`[generate_avatar] 已写入 ${dest}`)
    await new Promise((r) => setTimeout(r, 600))
  }

  if (!opts.noTransparentize) {
    const tol = parseBgToleranceFromEnv()
    const pngPaths = [join(outRoot, 'half_body.png'), ...manifest.entries.map((e) => join(outRoot, `${e.id}.png`))]
    console.error(
      `[generate_avatar] 去除背景（边缘 flood，与边框色容差 ${tol ?? '默认 ~38'}；可用 INFINITI_AVATAR_BG_TOLERANCE 或 --no-transparentize 调整）…`,
    )
    for (const p of pngPaths) {
      if (!existsSync(p)) continue
      try {
        const raw = await readFile(p)
        const out = await transparentizeStudioBackgroundPng(raw, tol)
        await writeFile(p, out)
        console.error(`[generate_avatar] 已透明背景 ${p}`)
      } catch (e) {
        throw new Error(`${p}: 透明背景处理失败 — ${(e as Error).message}`)
      }
    }
  } else {
    console.error('[generate_avatar] 已跳过透明背景（--no-transparentize）')
  }

  await writeFile(join(outRoot, 'expressions.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.error(`[generate_avatar] 已写入 ${join(outRoot, 'expressions.json')}`)
  console.error(
    `\n完成。请在 config.json 的 liveUi.spriteExpressions.dir 指向类似 ./live2d-models/${agent}/expression ，LiveUI 将加载 expressions.json 驱动表情映射与提示词。`,
  )
}
