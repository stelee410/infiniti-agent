export type LlmProvider = 'anthropic' | 'openai' | 'gemini'

export type McpServerConfig = {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

/** 单个 LLM 连接配置 */
export type LlmProfile = {
  provider: LlmProvider
  baseUrl: string
  model: string
  apiKey: string
}

/**
 * Extended thinking 模式：
 * - 'adaptive'  — 模型自行决定思考深度（推荐，Claude 4.6+ 支持）
 * - 'enabled'   — 固定 budget_tokens 上限
 * - 'disabled'  — 完全禁用
 * - undefined   — 等同 'adaptive'（默认值）
 */
export type ThinkingMode = 'adaptive' | 'enabled' | 'disabled'

export type ThinkingConfig = {
  mode?: ThinkingMode
  /** mode='enabled' 时的思考 token 预算，≥1024 且 < max_tokens；默认 10000 */
  budgetTokens?: number
}

export type CompactionConfig = {
  autoThresholdTokens?: number
  minTailMessages?: number
  maxToolSnippetChars?: number
  preCompactHook?: string
}

/**
 * LiveUI / Live2D（对齐 Open-LLM-VTuber：`live2d-models/` + `model_dict.json` + `live2d_model_name`）。
 *
 * 解析优先级：`live2dModel3Json` 直接路径 > `live2dModelName` + `live2dModelDict` 中的 `url`。
 * 相对路径均相对**当前工作目录**（项目根）。
 *
 * @example
 * ```json
 * "liveUi": {
 *   "port": 8080,
 *   "live2dModelsDir": "./live2d-models",
 *   "live2dModelDict": "./model_dict.json",
 *   "live2dModelName": "mao_pro"
 * }
 * ```
 * 或直接指定离线下载的 model3：
 * `"live2dModel3Json": "./live2d-models/mao_pro/runtime/mao_pro.model3.json"`
 */
export type LiveUiConfig = {
  /** WebSocket 端口；`infiniti-agent live` 未传 `--port` 时使用 */
  port?: number
  /**
   * Live2D 资源根目录（其下为各模型子目录，如 `mao_pro/runtime/…`）。
   * 与 VTuber 的 `live2d-models` 目录一致；用于把 `model_dict.json` 里以 `/live2d-models/` 开头的 `url` 映射到本地磁盘。
   */
  live2dModelsDir?: string
  /**
   * `model_dict.json` 路径（数组，元素含 `name`、`url`）。
   * 默认 `./model_dict.json`（仅当设置了 `live2dModelName` 且未指定 `live2dModel3Json` 时尝试读取）。
   */
  live2dModelDict?: string
  /** 在 model_dict 中选中的模型 `name`（对应 VTuber `character_config.live2d_model_name`） */
  live2dModelName?: string
  /** 直接指向 `.model3.json` 的绝对路径，或相对 cwd 的路径（优先级最高） */
  live2dModel3Json?: string
}

/**
 * 多 LLM 配置：
 *
 * 新格式（推荐）——在 llm.profiles 中定义多个命名配置：
 * ```json
 * {
 *   "llm": {
 *     "default": "main",
 *     "profiles": {
 *       "main":  { "provider": "anthropic", "baseUrl": "...", "model": "claude-sonnet-4-20250514", "apiKey": "..." },
 *       "fast":  { "provider": "openai",    "baseUrl": "...", "model": "gpt-4.1-mini",              "apiKey": "..." },
 *       "gate":  { "provider": "gemini",    "baseUrl": "...", "model": "gemini-2.0-flash",          "apiKey": "..." }
 *     }
 *   }
 * }
 * ```
 *
 * 旧格式（兼容）——平铺 provider/baseUrl/model/apiKey，等同只有一个 "default" profile。
 */
export type InfinitiConfig = {
  version: 1
  llm: {
    provider: LlmProvider
    baseUrl: string
    model: string
    apiKey: string
    /** 使用新多 profile 格式时，指定默认 profile 名 */
    default?: string
    /** 命名 LLM 配置集合 */
    profiles?: Record<string, LlmProfile>
  }
  mcp?: {
    servers?: Record<string, McpServerConfig>
  }
  compaction?: CompactionConfig
  thinking?: ThinkingConfig
  liveUi?: LiveUiConfig
}

/**
 * 按 profile 名解析 LLM 配置。
 * - 不传 profileName 或传 undefined → 使用 llm.default 指向的 profile，若无则用顶层 llm 字段
 * - 传入具体名称 → 从 profiles 中查找，找不到时 fallback 到顶层
 */
export function resolveLlmProfile(config: InfinitiConfig, profileName?: string): LlmProfile {
  const profiles = config.llm.profiles
  const name = profileName ?? config.llm.default

  if (name && profiles?.[name]) {
    return profiles[name]
  }
  return {
    provider: config.llm.provider,
    baseUrl: config.llm.baseUrl,
    model: config.llm.model,
    apiKey: config.llm.apiKey,
  }
}

export function isLlmProvider(v: string): v is LlmProvider {
  return v === 'anthropic' || v === 'openai' || v === 'gemini'
}
