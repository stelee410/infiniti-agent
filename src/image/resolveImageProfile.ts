import type { AvatarGenConfig, ImageProfile, ImageProvider, InfinitiConfig, SnapImageConfig } from '../config/types.js'
import { resolveLlmProfile } from '../config/types.js'

export type ResolvedImageProfile = Omit<ImageProfile, 'apiKey'> & {
  provider: 'openai' | 'openrouter' | 'gemini'
  apiKey: string
  timeoutMs: number
}

const DEFAULT_OPENROUTER = 'https://openrouter.ai/api/v1'
const DEFAULT_OPENAI_IMAGE_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_GEMINI_IMAGE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
const DEFAULT_NANO_BANANA_MODEL = 'google/gemini-3-pro-image-preview'
const DEFAULT_GPT_IMAGE_MODEL = 'gpt-image-2'
const DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image-preview'
const DEFAULT_TIMEOUT_MS = 120_000

function pickFirstNonEmpty(...vals: Array<string | undefined | null>): string {
  for (const v of vals) {
    const t = (v ?? '').trim()
    if (t) return t
  }
  return ''
}

type CanonicalImageProvider = ResolvedImageProfile['provider']

function normalizeImageProvider(provider?: string): CanonicalImageProvider {
  if (provider === 'gpt-image-2' || provider === 'chatgpt-image' || provider === 'openai') return 'openai'
  if (provider === 'gemini') return 'gemini'
  return 'openrouter'
}

function envApiKeyFor(provider: CanonicalImageProvider): string {
  if (provider === 'openai') return pickFirstNonEmpty(process.env.INFINITI_OPENAI_IMAGE_API_KEY, process.env.OPENAI_API_KEY)
  if (provider === 'gemini') return pickFirstNonEmpty(process.env.INFINITI_GEMINI_IMAGE_API_KEY, process.env.GEMINI_API_KEY, process.env.GOOGLE_API_KEY)
  return pickFirstNonEmpty(process.env.INFINITI_OPENROUTER_API_KEY, process.env.OPENROUTER_API_KEY)
}

function llmApiKeyFor(cfg: InfinitiConfig, provider: CanonicalImageProvider): string {
  const prof = resolveLlmProfile(cfg)
  if (provider === 'openai') {
    return pickFirstNonEmpty(
      prof.provider === 'openai' ? prof.apiKey : undefined,
      cfg.llm.provider === 'openai' ? cfg.llm.apiKey : undefined,
    )
  }
  if (provider === 'gemini') {
    return pickFirstNonEmpty(
      prof.provider === 'gemini' ? prof.apiKey : undefined,
      cfg.llm.provider === 'gemini' ? cfg.llm.apiKey : undefined,
    )
  }
  return pickFirstNonEmpty(
    prof.provider === 'openrouter' ? prof.apiKey : undefined,
    cfg.llm.provider === 'openrouter' ? cfg.llm.apiKey : undefined,
  )
}

function defaultsFor(provider: CanonicalImageProvider): Pick<ImageProfile, 'provider' | 'baseUrl' | 'model'> {
  if (provider === 'openai') return { provider, baseUrl: DEFAULT_OPENAI_IMAGE_BASE_URL, model: DEFAULT_GPT_IMAGE_MODEL }
  if (provider === 'gemini') return { provider, baseUrl: DEFAULT_GEMINI_IMAGE_BASE_URL, model: DEFAULT_GEMINI_IMAGE_MODEL }
  return { provider, baseUrl: DEFAULT_OPENROUTER, model: DEFAULT_NANO_BANANA_MODEL }
}

function resolveNamedProfile(cfg: InfinitiConfig, profileName?: string): ImageProfile | undefined {
  const profiles = cfg.image?.profiles
  const name = profileName?.trim() || cfg.image?.default?.trim()
  return name && profiles?.[name] ? profiles[name] : undefined
}

function completeProfile(cfg: InfinitiConfig, raw: Partial<ImageProfile> & { provider: ImageProvider | string }, directApiKey?: string): ResolvedImageProfile {
  const provider = normalizeImageProvider(raw.provider)
  const d = defaultsFor(provider)
  const apiKey = pickFirstNonEmpty(directApiKey, raw.apiKey, envApiKeyFor(provider), llmApiKeyFor(cfg, provider))
  if (!apiKey) {
    throw new Error(
      provider === 'openai'
        ? '缺少 OpenAI 图像 API Key：请在 image profile、avatarGen/snap、INFINITI_OPENAI_IMAGE_API_KEY 或 OPENAI_API_KEY 中配置'
        : provider === 'gemini'
          ? '缺少 Gemini 图像 API Key：请在 image profile、avatarGen/snap、INFINITI_GEMINI_IMAGE_API_KEY、GEMINI_API_KEY 或 GOOGLE_API_KEY 中配置'
          : '缺少 OpenRouter API Key：请在 image profile、avatarGen/snap、INFINITI_OPENROUTER_API_KEY 或 OPENROUTER_API_KEY 中配置',
    )
  }
  return {
    provider,
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
  const provider = normalizeImageProvider(ag.provider ?? (ag.model?.trim().startsWith('gpt-image-') ? 'openai' : undefined))
  return completeProfile(cfg, {
    provider,
    baseUrl: ag.baseUrl,
    model: pickFirstNonEmpty(ag.model, envModel),
    aspectRatio: ag.aspectRatio,
    imageSize: ag.imageSize,
    quality: ag.quality ?? (provider === 'openai' ? 'high' : undefined),
    transparentBackground: ag.transparentBackground,
  }, ag.apiKey)
}

export function resolveSnapImageProfile(cfg: InfinitiConfig): ResolvedImageProfile {
  const snap: SnapImageConfig = cfg.snap ?? {}
  const named = resolveNamedProfile(cfg, cfg.image?.snapProfile ?? snap.imageProfile)
  if (named) {
    return completeProfile(cfg, { ...named, provider: named.provider }, snap.apiKey)
  }
  const provider = normalizeImageProvider(snap.provider)
  return completeProfile(cfg, {
    provider,
    baseUrl: snap.baseUrl,
    model: snap.model,
    aspectRatio: snap.aspectRatio ?? (provider === 'openrouter' || provider === 'gemini' ? '4:3' : undefined),
    imageSize: snap.imageSize ?? (provider === 'openai' ? '1024x1024' : undefined),
    quality: snap.quality ?? (provider === 'openai' ? 'auto' : undefined),
    timeoutMs: snap.timeoutMs,
  }, snap.apiKey)
}
