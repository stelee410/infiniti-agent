import type { AvatarGenConfig, ImageProfile, ImageProvider, InfinitiConfig, SnapImageConfig } from '../config/types.js'
import { resolveLlmProfile } from '../config/types.js'

export type ResolvedImageProfile = Omit<ImageProfile, 'apiKey'> & {
  provider: ImageProvider
  apiKey: string
  timeoutMs: number
}

const DEFAULT_OPENROUTER = 'https://openrouter.ai/api/v1'
const DEFAULT_OPENAI_IMAGE_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_NANO_BANANA_MODEL = 'google/gemini-3-pro-image-preview'
const DEFAULT_GPT_IMAGE_MODEL = 'gpt-image-2'
const DEFAULT_TIMEOUT_MS = 120_000

function pickFirstNonEmpty(...vals: Array<string | undefined | null>): string {
  for (const v of vals) {
    const t = (v ?? '').trim()
    if (t) return t
  }
  return ''
}

function envApiKeyFor(provider: ImageProvider): string {
  return provider === 'gpt-image-2'
    ? pickFirstNonEmpty(process.env.INFINITI_OPENAI_IMAGE_API_KEY, process.env.OPENAI_API_KEY)
    : pickFirstNonEmpty(process.env.INFINITI_OPENROUTER_API_KEY, process.env.OPENROUTER_API_KEY)
}

function llmApiKeyFor(cfg: InfinitiConfig, provider: ImageProvider): string {
  const prof = resolveLlmProfile(cfg)
  if (provider === 'gpt-image-2') {
    return pickFirstNonEmpty(
      prof.provider === 'openai' ? prof.apiKey : undefined,
      cfg.llm.provider === 'openai' ? cfg.llm.apiKey : undefined,
    )
  }
  return pickFirstNonEmpty(
    prof.provider === 'openrouter' ? prof.apiKey : undefined,
    cfg.llm.provider === 'openrouter' ? cfg.llm.apiKey : undefined,
  )
}

function defaultsFor(provider: ImageProvider): Pick<ImageProfile, 'provider' | 'baseUrl' | 'model'> {
  return provider === 'gpt-image-2'
    ? { provider, baseUrl: DEFAULT_OPENAI_IMAGE_BASE_URL, model: DEFAULT_GPT_IMAGE_MODEL }
    : { provider, baseUrl: DEFAULT_OPENROUTER, model: DEFAULT_NANO_BANANA_MODEL }
}

function resolveNamedProfile(cfg: InfinitiConfig, profileName?: string): ImageProfile | undefined {
  const profiles = cfg.image?.profiles
  const name = profileName?.trim() || cfg.image?.default?.trim()
  return name && profiles?.[name] ? profiles[name] : undefined
}

function normalizeProvider(provider?: string): ImageProvider {
  if (provider === 'gpt-image-2' || provider === 'chatgpt-image') return 'gpt-image-2'
  return 'nano-banana'
}

function completeProfile(cfg: InfinitiConfig, raw: Partial<ImageProfile> & { provider: ImageProvider }, directApiKey?: string): ResolvedImageProfile {
  const d = defaultsFor(raw.provider)
  const apiKey = pickFirstNonEmpty(directApiKey, raw.apiKey, envApiKeyFor(raw.provider), llmApiKeyFor(cfg, raw.provider))
  if (!apiKey) {
    throw new Error(
      raw.provider === 'gpt-image-2'
        ? '缺少 OpenAI 图像 API Key：请在 image profile、avatarGen/snap、INFINITI_OPENAI_IMAGE_API_KEY 或 OPENAI_API_KEY 中配置'
        : '缺少 OpenRouter API Key：请在 image profile、avatarGen/snap、INFINITI_OPENROUTER_API_KEY 或 OPENROUTER_API_KEY 中配置',
    )
  }
  return {
    provider: raw.provider,
    baseUrl: raw.baseUrl?.trim() || d.baseUrl,
    apiKey,
    model: raw.model?.trim() || d.model,
    ...(raw.aspectRatio?.trim() ? { aspectRatio: raw.aspectRatio.trim() } : {}),
    ...(raw.imageSize?.trim() ? { imageSize: raw.imageSize.trim() } : {}),
    ...(raw.quality ? { quality: raw.quality } : {}),
    transparentBackground: raw.transparentBackground === true,
    timeoutMs: raw.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
}

export function resolveAvatarGenImageProfile(cfg: InfinitiConfig): ResolvedImageProfile {
  const ag: AvatarGenConfig = cfg.avatarGen ?? {}
  const named = resolveNamedProfile(cfg, cfg.image?.avatarGenProfile ?? ag.imageProfile)
  if (named) {
    return completeProfile(cfg, { ...named, provider: named.provider }, ag.apiKey)
  }
  const envModel = process.env.INFINITI_AVATAR_GEN_MODEL?.trim()
  const provider = normalizeProvider(ag.provider ?? (ag.model?.trim().startsWith('gpt-image-') ? 'gpt-image-2' : undefined))
  return completeProfile(cfg, {
    provider,
    baseUrl: ag.baseUrl,
    model: pickFirstNonEmpty(ag.model, envModel),
    aspectRatio: ag.aspectRatio,
    imageSize: ag.imageSize,
    quality: ag.quality ?? (provider === 'gpt-image-2' ? 'high' : undefined),
    transparentBackground: ag.transparentBackground,
  }, ag.apiKey)
}

export function resolveSnapImageProfile(cfg: InfinitiConfig): ResolvedImageProfile {
  const snap: SnapImageConfig = cfg.snap ?? {}
  const named = resolveNamedProfile(cfg, cfg.image?.snapProfile ?? snap.imageProfile)
  if (named) {
    return completeProfile(cfg, { ...named, provider: named.provider }, snap.apiKey)
  }
  const provider = normalizeProvider(snap.provider)
  return completeProfile(cfg, {
    provider,
    baseUrl: snap.baseUrl,
    model: snap.model,
    aspectRatio: snap.aspectRatio ?? (provider === 'nano-banana' ? '4:3' : undefined),
    imageSize: snap.imageSize ?? (provider === 'gpt-image-2' ? '1024x1024' : undefined),
    quality: snap.quality ?? (provider === 'gpt-image-2' ? 'auto' : undefined),
    timeoutMs: snap.timeoutMs,
  }, snap.apiKey)
}
