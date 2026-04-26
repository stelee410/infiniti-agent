export type LlmProvider = 'anthropic' | 'openai' | 'gemini' | 'minimax' | 'openrouter'

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
  /**
   * 为 true 时不向 API 发送 tools（如 Ollama 下不支持 function calling 的模型）。
   * 此时 agent 无法调用内置工具 / MCP，仅纯对话。
   */
  disableTools?: boolean
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
/** PNG 精灵表情（如 `live2d-models/luna/expression/exp_01.png`），与流式标签 / Live2D expression 名对齐。 */
export type LiveUiSpriteExpressionsConfig = {
  /**
   * 含 `exp_01.png` … `exp_08.png` 的目录（相对当前工作目录）。
   * 设置且路径有效时，LiveUI **仅**用该目录下 PNG 切换表情，**不再加载** `live2dModel3Json` / model_dict 的 Cubism 模型。
   */
  dir?: string
  /**
   * 表情 manifest（`expressions.json`）路径，相对 cwd。
   * 省略且 `dir` 下存在 `expressions.json` 时会自动读取。
   */
  manifest?: string
}

/**
 * `generate_avatar` 等使用的 OpenRouter 兼容图像 API（Nano Banana / Gemini Flash Image 等）。
 * `apiKey` 优先级：`avatarGen.apiKey` → 环境变量 `INFINITI_OPENROUTER_API_KEY` / `OPENROUTER_API_KEY` → 当前默认 LLM profile 的 `apiKey`。
 */
export type AvatarGenConfig = {
  provider?: 'gemini' | 'chatgpt-image'
  baseUrl?: string
  apiKey?: string
  /** 默认 `google/gemini-3-pro-image-preview`（Nano Banana Pro / Gemini 3 Pro Image）；可改为 `google/gemini-3.1-flash-image-preview`（Nano Banana 2）等 */
  model?: string
  aspectRatio?: string
  imageSize?: string
}

/** `/snap <提示词>` 合照 / 写实照片生成。 */
export type SnapImageConfig = {
  /** `nano-banana` 走 OpenRouter 图像模型；`gpt-image-2` 走 OpenAI Images API。 */
  provider?: 'nano-banana' | 'gpt-image-2'
  baseUrl?: string
  apiKey?: string
  /** nano-banana 默认 google/gemini-3-pro-image-preview；gpt-image-2 默认 gpt-image-2。 */
  model?: string
  /** OpenRouter image_config.aspect_ratio，如 16:9 / 4:3 / 1:1。 */
  aspectRatio?: string
  /** OpenRouter image_size 或 OpenAI size，如 auto / 1024x1024 / 1536x1024 / 1024x1536。 */
  imageSize?: string
  /** OpenAI quality，如 auto / high / medium / low。 */
  quality?: 'auto' | 'high' | 'medium' | 'low'
  /** 单次图像生成超时（毫秒），默认 120000。 */
  timeoutMs?: number
}

export type LiveUiConfig = {
  /** WebSocket 端口；`infiniti-agent live` 未传 `--port` 时使用 */
  port?: number
  /** LiveUI 启动后是否自动开启 TTS 播放；默认 true。 */
  ttsAutoEnabled?: boolean
  /** LiveUI 启动后是否自动开启 ASR 麦克风模式；默认 false。 */
  asrAutoEnabled?: boolean
  /** ASR 识别模式：manual = 按住空格录音；auto = VAD 自动识别。 */
  asrMode?: 'manual' | 'auto'
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

  /**
   * 语音模式：麦克风流 RMS 高于该值视为「在说话」（开始录音段 / 可触发打断）。
   * 未配置时默认约为 `0.015 × 1.3`；嘈杂环境可调高（如 `0.04`～`0.08`）。
   */
  voiceMicSpeechRmsThreshold?: number
  /** 说完一段后静音满多少毫秒再结束本段并送 ASR（毫秒，约 200～12000） */
  voiceMicSilenceEndMs?: number
  /**
   * 为 `true`（默认）时：TTS 正在本机播放期间不因麦克 RMS 发送 `INTERRUPT`，减轻串音误打断。
   */
  voiceMicSuppressInterruptDuringTts?: boolean

  /** 静态 PNG 表情目录（Luna 等），与 `emotionParse` / LiveUI 内 `emotionToExpressionId` 映射一致 */
  spriteExpressions?: LiveUiSpriteExpressionsConfig
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
    /**
     * 无 profiles 的旧格式下，与 LlmProfile.disableTools 同义。
     * 有 profiles 时请在各 profile 上设置 disableTools。
     */
    disableTools?: boolean
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
  tts?: TtsConfig
  asr?: AsrConfig
  avatarGen?: AvatarGenConfig
  snap?: SnapImageConfig
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
    const p = profiles[name]!
    if (p.disableTools !== undefined) return p
    if (config.llm.disableTools !== undefined) {
      return { ...p, disableTools: config.llm.disableTools }
    }
    return p
  }
  return {
    provider: config.llm.provider,
    baseUrl: config.llm.baseUrl,
    model: config.llm.model,
    apiKey: config.llm.apiKey,
    ...(config.llm.disableTools !== undefined ? { disableTools: config.llm.disableTools } : {}),
  }
}

/** MiniMax TTS 配置（同时用于 LiveUI 语音合成）。 */
export type MinimaxTtsConfig = {
  provider: 'minimax'
  apiKey: string
  /** MiniMax GroupId（必填，可在 https://platform.minimaxi.com 获取） */
  groupId: string
  /** TTS 模型，如 speech-02-hd / speech-02-turbo */
  model?: string
  /** 音色 ID，如 male-qn-qingse / female-shaonv */
  voiceId?: string
  /** 语速 0.5–2.0 */
  speed?: number
  /** 音量 0.1–10.0 */
  vol?: number
  /** 音调 -12–12 */
  pitch?: number
}

/**
 * 外部 [MOSS-TTS-Nano](https://github.com/OpenMOSS/MOSS-TTS-Nano) HTTP service。
 * 本仓库只配置 service URL；本地安装、模型下载和启动由 `infiniti-tts-service` 负责。
 */
export type MossTtsNanoConfig = {
  provider: 'moss_tts_nano'
  /** 服务根 URL，无尾斜杠，如 http://127.0.0.1:18083 */
  baseUrl: string
  /**
   * 语音克隆参考 wav（相对当前工作目录或绝对路径）。
   * 与 demoId 二选一即可；若两者都配，会同时上传文件并传 demo_id（以服务端解析为准）。
   */
  promptAudioPath?: string
  /** 使用服务端 `assets/demo.jsonl` 中的 demo_id（无上传时使用） */
  demoId?: string
  /** 单句合成超时（毫秒），默认 120000 */
  timeoutMs?: number
}

/**
 * 外部 [VoxCPM2](https://github.com/OpenBMB/VoxCPM) HTTP service。
 * 本仓库只配置 service URL；本地安装、模型下载和启动由 `infiniti-tts-service` 负责。
 */
export type VoxcpmTtsConfig = {
  provider: 'voxcpm'
  /** 服务根 URL，无尾斜杠，如 http://127.0.0.1:8810 */
  baseUrl: string
  /** 参考 wav（可选；不配时可用 controlInstruction 做声音设计） */
  referenceAudioPath?: string
  /** 声音设计 / 克隆风格描述，如「年轻女性，温柔甜美」 */
  controlInstruction?: string
  cfgValue?: number
  /** 扩散步数；过低易含糊/噪感，推荐约 20–30（更慢） */
  inferenceTimesteps?: number
  /** 是否启用服务端文本规范化（默认 false，与官方 Gradio 默认接近） */
  normalize?: boolean
  /**
   * 整句输出幅度归一化，减轻「同一段对话里时大时小」。
   * `rms` 按能量拉到固定 RMS（更稳），`peak` 按峰值压到 0.99，避免削波与忽大忽小；`none` 保持模型原始电平。
   * 默认 `rms`；流式接口会在整句生成完成后才写出 PCM（首包略晚一截）。
   */
  amplitudeNormalize?: 'none' | 'peak' | 'rms'
  /** 参考音频降噪（默认 true） */
  denoise?: boolean
  /** 单句合成超时（毫秒），默认 120000 */
  timeoutMs?: number
}

/** OpenAI-compatible speech TTS config placeholder for custom Whisper-style services. */
export type WhisperTtsConfig = {
  provider: 'whisper'
  apiKey: string
  baseUrl: string
  model?: string
  voiceId?: string
}

export type TtsConfig = MinimaxTtsConfig | MossTtsNanoConfig | VoxcpmTtsConfig | WhisperTtsConfig

/** 云端 Whisper ASR 配置（OpenAI-compatible）。 */
export type WhisperAsrConfig = {
  provider: 'whisper'
  apiKey: string
  baseUrl: string
  model?: string
  lang?: string
}

/** 本地 sherpa-onnx SenseVoice ASR 配置。 */
export type SherpaOnnxAsrConfig = {
  provider: 'sherpa_onnx'
  /** 模型 .onnx 文件路径（相对于 cwd） */
  model: string
  /** tokens.txt 文件路径（相对于 cwd） */
  tokens: string
  /** 语言代码：zh / en / auto */
  lang?: string
  /** 推理线程数（默认 4） */
  numThreads?: number
}

export type AsrConfig = WhisperAsrConfig | SherpaOnnxAsrConfig

export function isLlmProvider(v: string): v is LlmProvider {
  return (
    v === 'anthropic' ||
    v === 'openai' ||
    v === 'gemini' ||
    v === 'minimax' ||
    v === 'openrouter'
  )
}
