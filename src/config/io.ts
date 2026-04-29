import { existsSync } from 'fs'
import { mkdir, readFile, writeFile, chmod } from 'fs/promises'
import { dirname } from 'path'
import { constants } from 'fs'
import { GLOBAL_AGENT_DIR, GLOBAL_CONFIG_PATH, localConfigPath, localAgentDir } from '../paths.js'
import type {
  AsrConfig,
  AvatarGenConfig,
  CompactionConfig,
  InfinitiConfig,
  LiveUiConfig,
  LlmProfile,
  McpServerConfig,
  SeedanceVideoConfig,
  SnapImageConfig,
  TtsConfig,
} from './types.js'
import { isLlmProvider } from './types.js'
import { PROVIDER_DEFAULTS } from './defaults.js'

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export async function ensureLocalAgentDir(cwd: string): Promise<void> {
  await mkdir(localAgentDir(cwd), { recursive: true })
}

export async function ensureGlobalDir(): Promise<void> {
  await mkdir(GLOBAL_AGENT_DIR, { recursive: true, mode: 0o700 })
}

/** 本地 .infiniti-agent/config.json 优先，全局 ~/.infiniti-agent/config.json fallback */
export function configExistsSync(cwd?: string): boolean {
  if (cwd && existsSync(localConfigPath(cwd))) return true
  return existsSync(GLOBAL_CONFIG_PATH)
}

/** 解析出实际使用的 config 文件路径 */
function resolveConfigPath(cwd?: string): string {
  if (cwd && existsSync(localConfigPath(cwd))) return localConfigPath(cwd)
  return GLOBAL_CONFIG_PATH
}

/** 供 CLI 日志：当前 cwd 下实际读取的 config.json 路径 */
export function getInfinitiConfigPath(cwd?: string): string {
  return resolveConfigPath(cwd)
}

export async function loadConfig(cwd?: string): Promise<InfinitiConfig> {
  const cfgPath = resolveConfigPath(cwd)
  let raw: string
  try {
    raw = await readFile(cfgPath, 'utf8')
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOENT') {
      throw new ConfigError(
        '尚未配置。请运行: infiniti-agent init',
      )
    }
    throw e
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ConfigError('config.json 不是合法 JSON')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new ConfigError('config.json 格式无效')
  }
  const o = parsed as Record<string, unknown>
  if (o.version !== 1) {
    throw new ConfigError('不支持的 config version，请使用 version: 1')
  }
  const llm = o.llm as Record<string, unknown> | undefined
  if (!llm || typeof llm !== 'object') {
    throw new ConfigError('缺少 llm 配置块')
  }

  const profiles = parseLlmProfiles(llm.profiles)
  const defaultProfile = typeof llm.default === 'string' ? llm.default.trim() : undefined
  const metaAgentProfile =
    typeof llm.metaAgentProfile === 'string' && llm.metaAgentProfile.trim()
      ? llm.metaAgentProfile.trim()
      : undefined
  const subconsciousProfile =
    typeof llm.subconsciousProfile === 'string' && llm.subconsciousProfile.trim()
      ? llm.subconsciousProfile.trim()
      : undefined

  let provider: string | undefined
  let baseUrl: string | undefined
  let model: string | undefined
  let apiKey: string | undefined

  if (profiles && defaultProfile && profiles[defaultProfile]) {
    const dp = profiles[defaultProfile]
    provider = dp.provider
    baseUrl = dp.baseUrl
    model = dp.model
    apiKey = dp.apiKey
  } else if (profiles) {
    const first = Object.values(profiles)[0]
    if (first) {
      provider = first.provider
      baseUrl = first.baseUrl
      model = first.model
      apiKey = first.apiKey
    }
  }

  provider = provider ?? (llm.provider as string | undefined)
  baseUrl = baseUrl ?? (llm.baseUrl as string | undefined)
  model = model ?? (llm.model as string | undefined)
  apiKey = apiKey ?? (llm.apiKey as string | undefined)

  if (typeof provider !== 'string' || !isLlmProvider(provider)) {
    throw new ConfigError(
      'llm.provider 必须是 anthropic | openai | gemini | minimax | openrouter（或在 profiles 中配置）',
    )
  }
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    throw new ConfigError('llm.baseUrl 无效')
  }
  if (typeof model !== 'string' || !model.trim()) {
    throw new ConfigError('llm.model 无效')
  }
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new ConfigError('llm.apiKey 无效')
  }

  const mcp = o.mcp as Record<string, unknown> | undefined
  const compaction = parseCompactionConfig(o.compaction)
  const liveUi = parseLiveUiConfig(o.liveUi)
  const tts = parseTtsConfig(o.tts)
  const asr = parseAsrConfig(o.asr)
  const avatarGen = parseAvatarGenConfig(o.avatarGen)
  const snap = parseSnapImageConfig(o.snap)
  const seedance = parseSeedanceVideoConfig(o.seedance)

  const flatDisableTools = llm.disableTools
  const resolvedDisableTools =
    profiles && defaultProfile && profiles[defaultProfile]?.disableTools !== undefined
      ? profiles[defaultProfile]!.disableTools
      : typeof flatDisableTools === 'boolean'
        ? flatDisableTools
        : undefined

  return {
    version: 1,
    llm: {
      provider,
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      apiKey: apiKey.trim(),
      ...(resolvedDisableTools !== undefined ? { disableTools: resolvedDisableTools } : {}),
      ...(defaultProfile ? { default: defaultProfile } : {}),
      ...(metaAgentProfile ? { metaAgentProfile } : {}),
      ...(subconsciousProfile ? { subconsciousProfile } : {}),
      ...(profiles ? { profiles } : {}),
    },
    mcp:
      mcp && typeof mcp === 'object' && mcp.servers && typeof mcp.servers === 'object'
        ? {
            servers: mcp.servers as Record<string, McpServerConfig>,
          }
        : undefined,
    ...(compaction ? { compaction } : {}),
    ...(liveUi ? { liveUi } : {}),
    ...(tts ? { tts } : {}),
    ...(asr ? { asr } : {}),
    ...(avatarGen ? { avatarGen } : {}),
    ...(snap ? { snap } : {}),
    ...(seedance ? { seedance } : {}),
  }
}

function parseStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out = raw.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean)
  return out.length ? out : undefined
}

function parseAvatarGenConfig(raw: unknown): AvatarGenConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const u = raw as Record<string, unknown>
  const out: AvatarGenConfig = {}
  if (u.provider === 'gemini' || u.provider === 'chatgpt-image') out.provider = u.provider
  if (typeof u.baseUrl === 'string' && u.baseUrl.trim()) out.baseUrl = u.baseUrl.trim()
  if (typeof u.apiKey === 'string' && u.apiKey.trim()) out.apiKey = u.apiKey.trim()
  if (typeof u.model === 'string' && u.model.trim()) out.model = u.model.trim()
  if (typeof u.aspectRatio === 'string' && u.aspectRatio.trim()) out.aspectRatio = u.aspectRatio.trim()
  if (typeof u.imageSize === 'string' && u.imageSize.trim()) out.imageSize = u.imageSize.trim()
  return Object.keys(out).length ? out : undefined
}

function parseSnapImageConfig(raw: unknown): SnapImageConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const u = raw as Record<string, unknown>
  const out: SnapImageConfig = {}
  if (u.provider === 'nano-banana' || u.provider === 'gpt-image-2') out.provider = u.provider
  if (typeof u.baseUrl === 'string' && u.baseUrl.trim()) out.baseUrl = u.baseUrl.trim()
  if (typeof u.apiKey === 'string' && u.apiKey.trim()) out.apiKey = u.apiKey.trim()
  if (typeof u.model === 'string' && u.model.trim()) out.model = u.model.trim()
  if (typeof u.aspectRatio === 'string' && u.aspectRatio.trim()) out.aspectRatio = u.aspectRatio.trim()
  if (typeof u.imageSize === 'string' && u.imageSize.trim()) out.imageSize = u.imageSize.trim()
  if (u.quality === 'auto' || u.quality === 'high' || u.quality === 'medium' || u.quality === 'low') {
    out.quality = u.quality
  }
  if (typeof u.timeoutMs === 'number' && Number.isFinite(u.timeoutMs) && u.timeoutMs >= 5000) {
    out.timeoutMs = Math.floor(u.timeoutMs)
  }
  return Object.keys(out).length ? out : undefined
}

function parseSeedanceVideoConfig(raw: unknown): SeedanceVideoConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const u = raw as Record<string, unknown>
  const out: SeedanceVideoConfig = {}
  if (u.provider === 'volcengine') out.provider = u.provider
  if (typeof u.baseUrl === 'string' && u.baseUrl.trim()) out.baseUrl = u.baseUrl.trim()
  if (typeof u.apiKey === 'string' && u.apiKey.trim()) out.apiKey = u.apiKey.trim()
  if (typeof u.model === 'string' && u.model.trim()) out.model = u.model.trim()
  if (typeof u.ratio === 'string' && u.ratio.trim()) out.ratio = u.ratio.trim()
  if (typeof u.duration === 'number' && Number.isFinite(u.duration) && u.duration > 0) {
    out.duration = Math.floor(u.duration)
  }
  if (typeof u.resolution === 'string' && u.resolution.trim()) out.resolution = u.resolution.trim()
  if (typeof u.generateAudio === 'boolean') out.generateAudio = u.generateAudio
  if (typeof u.watermark === 'boolean') out.watermark = u.watermark
  const imageUrls = parseStringArray(u.referenceImageUrls)
  const videoUrls = parseStringArray(u.referenceVideoUrls)
  const audioUrls = parseStringArray(u.referenceAudioUrls)
  if (imageUrls) out.referenceImageUrls = imageUrls
  if (videoUrls) out.referenceVideoUrls = videoUrls
  if (audioUrls) out.referenceAudioUrls = audioUrls
  if (typeof u.pollIntervalMs === 'number' && Number.isFinite(u.pollIntervalMs) && u.pollIntervalMs >= 1000) {
    out.pollIntervalMs = Math.floor(u.pollIntervalMs)
  }
  if (typeof u.timeoutMs === 'number' && Number.isFinite(u.timeoutMs) && u.timeoutMs >= 10000) {
    out.timeoutMs = Math.floor(u.timeoutMs)
  }
  return Object.keys(out).length ? out : undefined
}

function parseLiveUiConfig(raw: unknown): LiveUiConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const u = raw as Record<string, unknown>
  const out: LiveUiConfig = {}
  if (typeof u.port === 'number' && Number.isFinite(u.port)) {
    const p = Math.floor(u.port)
    if (p >= 1 && p <= 65535) out.port = p
  }
  if (typeof u.ttsAutoEnabled === 'boolean') {
    out.ttsAutoEnabled = u.ttsAutoEnabled
  }
  if (u.renderer === 'live2d' || u.renderer === 'sprite' || u.renderer === 'real2d') {
    out.renderer = u.renderer
  }
  if (typeof u.asrAutoEnabled === 'boolean') {
    out.asrAutoEnabled = u.asrAutoEnabled
  }
  if (u.asrMode === 'manual' || u.asrMode === 'auto') {
    out.asrMode = u.asrMode
  }
  if (typeof u.live2dModelsDir === 'string' && u.live2dModelsDir.trim()) {
    out.live2dModelsDir = u.live2dModelsDir.trim()
  }
  if (typeof u.live2dModelDict === 'string' && u.live2dModelDict.trim()) {
    out.live2dModelDict = u.live2dModelDict.trim()
  }
  if (typeof u.live2dModelName === 'string' && u.live2dModelName.trim()) {
    out.live2dModelName = u.live2dModelName.trim()
  }
  if (typeof u.live2dModel3Json === 'string' && u.live2dModel3Json.trim()) {
    out.live2dModel3Json = u.live2dModel3Json.trim()
  }
  if (typeof u.voiceMicSpeechRmsThreshold === 'number' && Number.isFinite(u.voiceMicSpeechRmsThreshold)) {
    const t = u.voiceMicSpeechRmsThreshold
    if (t > 0 && t <= 0.35) out.voiceMicSpeechRmsThreshold = t
  }
  if (typeof u.voiceMicSilenceEndMs === 'number' && Number.isFinite(u.voiceMicSilenceEndMs)) {
    const ms = Math.round(u.voiceMicSilenceEndMs)
    if (ms >= 200 && ms <= 12000) out.voiceMicSilenceEndMs = ms
  }
  if (typeof u.voiceMicSuppressInterruptDuringTts === 'boolean') {
    out.voiceMicSuppressInterruptDuringTts = u.voiceMicSuppressInterruptDuringTts
  }
  const se = u.spriteExpressions
  if (se && typeof se === 'object') {
    const s = se as Record<string, unknown>
    const dir = typeof s.dir === 'string' && s.dir.trim() ? s.dir.trim() : undefined
    const manifest = typeof s.manifest === 'string' && s.manifest.trim() ? s.manifest.trim() : undefined
    if (dir || manifest) {
      out.spriteExpressions = { ...(dir ? { dir } : {}), ...(manifest ? { manifest } : {}) }
    }
  }
  return Object.keys(out).length ? out : undefined
}

function parseLlmProfiles(raw: unknown): Record<string, LlmProfile> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const src = raw as Record<string, unknown>
  const out: Record<string, LlmProfile> = {}
  for (const [name, v] of Object.entries(src)) {
    if (!v || typeof v !== 'object') continue
    const p = v as Record<string, unknown>
    if (
      typeof p.provider === 'string' && isLlmProvider(p.provider) &&
      typeof p.baseUrl === 'string' && p.baseUrl.trim() &&
      typeof p.model === 'string' && p.model.trim() &&
      typeof p.apiKey === 'string' && p.apiKey.trim()
    ) {
      const prof: LlmProfile = {
        provider: p.provider,
        baseUrl: p.baseUrl.trim(),
        model: p.model.trim(),
        apiKey: p.apiKey.trim(),
      }
      if (typeof p.disableTools === 'boolean') {
        prof.disableTools = p.disableTools
      }
      out[name] = prof
    }
  }
  return Object.keys(out).length ? out : undefined
}

function parseCompactionConfig(raw: unknown): CompactionConfig | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined
  }
  const c = raw as Record<string, unknown>
  const out: CompactionConfig = {}
  if (typeof c.autoThresholdTokens === 'number' && c.autoThresholdTokens >= 0) {
    out.autoThresholdTokens = Math.floor(c.autoThresholdTokens)
  }
  if (typeof c.minTailMessages === 'number' && c.minTailMessages >= 1) {
    out.minTailMessages = Math.floor(c.minTailMessages)
  }
  if (typeof c.maxToolSnippetChars === 'number' && c.maxToolSnippetChars >= 200) {
    out.maxToolSnippetChars = Math.floor(c.maxToolSnippetChars)
  }
  if (typeof c.preCompactHook === 'string' && c.preCompactHook.trim()) {
    out.preCompactHook = c.preCompactHook.trim()
  }
  return Object.keys(out).length ? out : undefined
}

function parseTtsConfig(raw: unknown): TtsConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const t = raw as Record<string, unknown>
  if (t.provider === 'minimax') {
    if (typeof t.apiKey !== 'string' || !t.apiKey.trim()) return undefined
    if (typeof t.groupId !== 'string' || !t.groupId.trim()) return undefined
    const out: TtsConfig = { provider: 'minimax', apiKey: t.apiKey.trim(), groupId: t.groupId.trim() }
    if (typeof t.model === 'string' && t.model.trim()) out.model = t.model.trim()
    if (typeof t.voiceId === 'string' && t.voiceId.trim()) out.voiceId = t.voiceId.trim()
    if (typeof t.speed === 'number' && t.speed > 0) out.speed = t.speed
    if (typeof t.vol === 'number' && t.vol > 0) out.vol = t.vol
    if (typeof t.pitch === 'number') out.pitch = t.pitch
    return out
  }
  if (t.provider === 'moss_tts_nano') {
    if (typeof t.baseUrl !== 'string' || !t.baseUrl.trim()) return undefined
    const prompt =
      typeof t.promptAudioPath === 'string' && t.promptAudioPath.trim()
        ? t.promptAudioPath.trim()
        : undefined
    const demo = typeof t.demoId === 'string' && t.demoId.trim() ? t.demoId.trim() : undefined
    const out: TtsConfig = { provider: 'moss_tts_nano', baseUrl: t.baseUrl.trim() }
    if (prompt) out.promptAudioPath = prompt
    if (demo) out.demoId = demo
    if (typeof t.timeoutMs === 'number' && t.timeoutMs >= 5000 && Number.isFinite(t.timeoutMs)) {
      out.timeoutMs = Math.floor(t.timeoutMs)
    }
    return out
  }
  if (t.provider === 'voxcpm') {
    if (typeof t.baseUrl !== 'string' || !t.baseUrl.trim()) return undefined
    const out: TtsConfig = { provider: 'voxcpm', baseUrl: t.baseUrl.trim() }
    if (typeof t.referenceAudioPath === 'string' && t.referenceAudioPath.trim()) {
      out.referenceAudioPath = t.referenceAudioPath.trim()
    }
    if (typeof t.controlInstruction === 'string' && t.controlInstruction.trim()) {
      out.controlInstruction = t.controlInstruction.trim()
    }
    if (typeof t.cfgValue === 'number' && Number.isFinite(t.cfgValue) && t.cfgValue > 0) {
      out.cfgValue = t.cfgValue
    }
    if (typeof t.inferenceTimesteps === 'number' && t.inferenceTimesteps >= 1) {
      out.inferenceTimesteps = Math.floor(t.inferenceTimesteps)
    }
    if (typeof t.normalize === 'boolean') out.normalize = t.normalize
    if (t.amplitudeNormalize === 'none' || t.amplitudeNormalize === 'peak' || t.amplitudeNormalize === 'rms') {
      out.amplitudeNormalize = t.amplitudeNormalize
    }
    if (typeof t.denoise === 'boolean') out.denoise = t.denoise
    if (typeof t.timeoutMs === 'number' && t.timeoutMs >= 5000 && Number.isFinite(t.timeoutMs)) {
      out.timeoutMs = Math.floor(t.timeoutMs)
    }
    return out
  }
  if (t.provider === 'whisper') {
    if (typeof t.apiKey !== 'string' || !t.apiKey.trim()) return undefined
    if (typeof t.baseUrl !== 'string' || !t.baseUrl.trim()) return undefined
    const out: TtsConfig = { provider: 'whisper', apiKey: t.apiKey.trim(), baseUrl: t.baseUrl.trim() }
    if (typeof t.model === 'string' && t.model.trim()) out.model = t.model.trim()
    if (typeof t.voiceId === 'string' && t.voiceId.trim()) out.voiceId = t.voiceId.trim()
    return out
  }
  return undefined
}

function parseAsrConfig(raw: unknown): AsrConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const a = raw as Record<string, unknown>
  if (a.provider === 'whisper') {
    if (typeof a.apiKey !== 'string' || !a.apiKey.trim()) return undefined
    if (typeof a.baseUrl !== 'string' || !a.baseUrl.trim()) return undefined
    const out: AsrConfig = { provider: 'whisper', apiKey: a.apiKey.trim(), baseUrl: a.baseUrl.trim() }
    if (typeof a.model === 'string' && a.model.trim()) out.model = a.model.trim()
    if (typeof a.lang === 'string' && a.lang.trim()) out.lang = a.lang.trim()
    return out
  }
  if (a.provider === 'sherpa_onnx') {
    if (typeof a.model !== 'string' || !a.model.trim()) return undefined
    if (typeof a.tokens !== 'string' || !a.tokens.trim()) return undefined
    const out: AsrConfig = { provider: 'sherpa_onnx', model: a.model.trim(), tokens: a.tokens.trim() }
    if (typeof a.lang === 'string' && a.lang.trim()) out.lang = a.lang.trim()
    if (typeof a.numThreads === 'number' && a.numThreads >= 1) out.numThreads = Math.floor(a.numThreads)
    return out
  }
  return undefined
}

export type SaveConfigInput = {
  /** 所有 profiles（key = profile 名） */
  profiles: Record<string, LlmProfile>
  /** 默认 profile 名 */
  defaultProfile: string
}

/** 写入当前项目 `.infiniti-agent/config.json`（不覆盖全局配置）。 */
export async function saveProjectConfig(cwd: string, cfg: InfinitiConfig): Promise<void> {
  const target = localConfigPath(cwd)
  await ensureLocalAgentDir(cwd)
  await writeFile(target, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
  try {
    await chmod(target, constants.S_IRUSR | constants.S_IWUSR)
  } catch {
    /* Windows 等环境可能不支持 chmod */
  }
}

export async function saveConfig(input: SaveConfigInput): Promise<void> {
  await ensureGlobalDir()
  let existing: InfinitiConfig | null = null
  try {
    existing = await loadConfig()
  } catch {
    existing = null
  }

  const defaultLlm = input.profiles[input.defaultProfile]!
  const cfg: InfinitiConfig = {
    version: 1,
    llm: {
      provider: defaultLlm.provider,
      baseUrl: defaultLlm.baseUrl,
      model: defaultLlm.model,
      apiKey: defaultLlm.apiKey,
      default: input.defaultProfile,
      ...(existing?.llm.metaAgentProfile ? { metaAgentProfile: existing.llm.metaAgentProfile } : {}),
      ...(existing?.llm.subconsciousProfile ? { subconsciousProfile: existing.llm.subconsciousProfile } : {}),
      profiles: input.profiles,
    },
    mcp: existing?.mcp ?? {
      servers: {},
    },
    ...(existing?.compaction ? { compaction: existing.compaction } : {}),
    ...(existing?.liveUi ? { liveUi: existing.liveUi } : {}),
    ...(existing?.tts ? { tts: existing.tts } : {}),
    ...(existing?.asr ? { asr: existing.asr } : {}),
    ...(existing?.avatarGen ? { avatarGen: existing.avatarGen } : {}),
    ...(existing?.snap ? { snap: existing.snap } : {}),
    ...(existing?.seedance ? { seedance: existing.seedance } : {}),
  }
  const target = GLOBAL_CONFIG_PATH
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
  try {
    await chmod(target, constants.S_IRUSR | constants.S_IWUSR)
  } catch {
    /* Windows 等环境可能不支持 chmod */
  }
}

export type UpgradeResult = {
  changed: boolean
  path: string
  changes: string[]
}

/**
 * 将指定路径的 config.json 升级到最新格式：
 * - 旧平铺 llm 字段 → profiles + default
 * - 移除已废弃的 skills.directories
 */
export async function upgradeConfig(configPath: string): Promise<UpgradeResult> {
  const result: UpgradeResult = { changed: false, path: configPath, changes: [] }

  let raw: string
  try {
    raw = await readFile(configPath, 'utf8')
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOENT') {
      throw new ConfigError(`配置文件不存在: ${configPath}`)
    }
    throw e
  }

  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new ConfigError('config.json 不是合法 JSON')
  }

  const llm = obj.llm as Record<string, unknown> | undefined
  if (!llm || typeof llm !== 'object') {
    throw new ConfigError('缺少 llm 配置块')
  }

  if (!llm.profiles) {
    const provider = llm.provider as string
    const baseUrl = llm.baseUrl as string
    const model = llm.model as string
    const apiKey = llm.apiKey as string

    if (!provider || !baseUrl || !model || !apiKey) {
      throw new ConfigError('llm 配置不完整，无法升级')
    }

    llm.default = 'main'
    llm.profiles = {
      main: { provider, baseUrl, model, apiKey },
    }
    result.changed = true
    result.changes.push('llm: 平铺字段 → profiles.main + default="main"')
  }

  if (obj.skills && typeof obj.skills === 'object') {
    delete obj.skills
    result.changed = true
    result.changes.push('移除已废弃的 skills.directories（skills 现在存储在项目级 .infiniti-agent/skills/）')
  }

  if (result.changed) {
    await writeFile(configPath, `${JSON.stringify(obj, null, 2)}\n`, 'utf8')
    try {
      await chmod(configPath, constants.S_IRUSR | constants.S_IWUSR)
    } catch { /* ignore */ }
  }

  return result
}
