import { existsSync } from 'fs'
import { mkdir, readFile, writeFile, chmod } from 'fs/promises'
import { dirname } from 'path'
import { constants } from 'fs'
import { GLOBAL_AGENT_DIR, GLOBAL_CONFIG_PATH, localConfigPath, localAgentDir } from '../paths.js'
import type {
  CompactionConfig,
  InfinitiConfig,
  LlmProfile,
  McpServerConfig,
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
    throw new ConfigError('llm.provider 必须是 anthropic | openai | gemini（或在 profiles 中配置）')
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

  return {
    version: 1,
    llm: {
      provider,
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      apiKey: apiKey.trim(),
      ...(defaultProfile ? { default: defaultProfile } : {}),
      ...(profiles ? { profiles } : {}),
    },
    mcp:
      mcp && typeof mcp === 'object' && mcp.servers && typeof mcp.servers === 'object'
        ? {
            servers: mcp.servers as Record<string, McpServerConfig>,
          }
        : undefined,
    ...(compaction ? { compaction } : {}),
  }
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
      out[name] = {
        provider: p.provider,
        baseUrl: p.baseUrl.trim(),
        model: p.model.trim(),
        apiKey: p.apiKey.trim(),
      }
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

export type SaveConfigInput = {
  /** 所有 profiles（key = profile 名） */
  profiles: Record<string, LlmProfile>
  /** 默认 profile 名 */
  defaultProfile: string
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
      profiles: input.profiles,
    },
    mcp: existing?.mcp ?? {
      servers: {},
    },
    ...(existing?.compaction ? { compaction: existing.compaction } : {}),
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
