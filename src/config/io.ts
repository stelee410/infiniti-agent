import { existsSync } from 'fs'
import { mkdir, readFile, writeFile, chmod } from 'fs/promises'
import { dirname } from 'path'
import { constants } from 'fs'
import { GLOBAL_AGENT_DIR, GLOBAL_CONFIG_PATH, localConfigPath, localAgentDir } from '../paths.js'
import type {
  CompactionConfig,
  InfinitiConfig,
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
  const provider = llm.provider
  const baseUrl = llm.baseUrl
  const model = llm.model
  const apiKey = llm.apiKey
  if (typeof provider !== 'string' || !isLlmProvider(provider)) {
    throw new ConfigError('llm.provider 必须是 anthropic | openai | gemini')
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

  const skills = o.skills as Record<string, unknown> | undefined
  const mcp = o.mcp as Record<string, unknown> | undefined
  const compaction = parseCompactionConfig(o.compaction)

  return {
    version: 1,
    llm: {
      provider,
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      apiKey: apiKey.trim(),
    },
    skills:
      skills && typeof skills === 'object'
        ? {
            directories: Array.isArray(skills.directories)
              ? skills.directories.filter((x): x is string => typeof x === 'string')
              : undefined,
          }
        : undefined,
    mcp:
      mcp && typeof mcp === 'object' && mcp.servers && typeof mcp.servers === 'object'
        ? {
            servers: mcp.servers as Record<string, McpServerConfig>,
          }
        : undefined,
    ...(compaction ? { compaction } : {}),
  }
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

export async function saveConfig(partial: {
  provider: InfinitiConfig['llm']['provider']
  baseUrl: string
  model: string
  apiKey: string
}): Promise<void> {
  await ensureGlobalDir()
  const defaults = PROVIDER_DEFAULTS[partial.provider]
  let existing: InfinitiConfig | null = null
  try {
    existing = await loadConfig()
  } catch {
    existing = null
  }
  const cfg: InfinitiConfig = {
    version: 1,
    llm: {
      provider: partial.provider,
      baseUrl: partial.baseUrl.trim() || defaults.baseUrl,
      model: partial.model.trim() || defaults.model,
      apiKey: partial.apiKey.trim(),
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
