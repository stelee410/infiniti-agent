export type JsonObj = Record<string, any>

export function cloneConfig(v: unknown): JsonObj {
  try {
    return JSON.parse(JSON.stringify(v ?? {}))
  } catch {
    return {}
  }
}

export function text(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export function num(v: unknown, fallback = ''): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : fallback
}

export function lines(v: unknown): string {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string').join('\n') : ''
}

export function splitLines(v: string): string[] {
  return v.split(/[\n,]/).map((x) => x.trim()).filter(Boolean)
}

export function findMimoApiKey(cfg: JsonObj): string {
  const ttsKey = text(cfg.tts?.apiKey)
  if (ttsKey) return ttsKey
  const llm = cfg.llm
  const profiles = llm?.profiles && typeof llm.profiles === 'object' ? llm.profiles as Record<string, JsonObj> : {}
  for (const p of Object.values(profiles)) {
    if (text(p.baseUrl).includes('xiaomimimo.com') && text(p.apiKey)) return text(p.apiKey)
  }
  if (text(llm?.baseUrl).includes('xiaomimimo.com')) return text(llm?.apiKey)
  return ''
}

export function defaultTtsConfig(provider: string, cfg: JsonObj): JsonObj | undefined {
  if (!provider) return undefined
  const current = cfg.tts && typeof cfg.tts === 'object' ? cfg.tts as JsonObj : {}
  if (provider === 'mimo') {
    return {
      provider,
      baseUrl: text(current.baseUrl) || 'https://token-plan-cn.xiaomimimo.com/v1',
      model: text(current.model) || 'mimo-v2.5-tts-voiceclone',
      apiKey: text(current.apiKey) || findMimoApiKey(cfg),
      referenceAudioPath: text(current.referenceAudioPath) || '.infiniti-agent/assets/mimo-voiceclone-reference.wav',
      format: text(current.format) || 'wav',
      controlInstruction: text(current.controlInstruction) || '自然、清晰、语速适中。',
      timeoutMs: typeof current.timeoutMs === 'number' ? current.timeoutMs : 120000,
    }
  }
  if (provider === 'voxcpm') {
    return {
      provider,
      baseUrl: text(current.baseUrl) || 'http://127.0.0.1:8810',
      controlInstruction: text(current.controlInstruction) || '年轻女性，温柔自然，语速适中',
      cfgValue: typeof current.cfgValue === 'number' ? current.cfgValue : 2,
      inferenceTimesteps: typeof current.inferenceTimesteps === 'number' ? current.inferenceTimesteps : 20,
      normalize: typeof current.normalize === 'boolean' ? current.normalize : true,
      denoise: typeof current.denoise === 'boolean' ? current.denoise : true,
      timeoutMs: typeof current.timeoutMs === 'number' ? current.timeoutMs : 300000,
    }
  }
  if (provider === 'moss_tts_nano') {
    return { provider, baseUrl: text(current.baseUrl) || 'http://127.0.0.1:18083' }
  }
  if (provider === 'minimax') {
    return {
      provider,
      apiKey: text(current.apiKey),
      groupId: text(current.groupId),
      model: text(current.model) || 'speech-02-turbo',
      voiceId: text(current.voiceId) || 'female-shaonv',
    }
  }
  if (provider === 'whisper') {
    return {
      provider,
      baseUrl: text(current.baseUrl),
      apiKey: text(current.apiKey),
      model: text(current.model),
      voiceId: text(current.voiceId),
    }
  }
  return { provider }
}

export function ensureLlmProfiles(cfg: JsonObj): Record<string, JsonObj> {
  cfg.llm ??= {}
  if (!cfg.llm.profiles || typeof cfg.llm.profiles !== 'object') {
    cfg.llm.profiles = {
      main: {
        provider: cfg.llm.provider || 'openai',
        baseUrl: cfg.llm.baseUrl || '',
        model: cfg.llm.model || '',
        apiKey: cfg.llm.apiKey || '',
        ...(cfg.llm.disableTools !== undefined ? { disableTools: !!cfg.llm.disableTools } : {}),
      },
    }
    cfg.llm.default = cfg.llm.default || 'main'
  }
  return cfg.llm.profiles
}

export function defaultImageProfile(provider: string, current: JsonObj = {}): JsonObj {
  if (provider === 'gpt-image-2') {
    return {
      provider,
      baseUrl: text(current.baseUrl) || 'https://api.openai.com/v1',
      apiKey: text(current.apiKey),
      model: text(current.model) || 'gpt-image-2',
      imageSize: text(current.imageSize) || '1024x1536',
      quality: text(current.quality) || 'high',
      transparentBackground: current.transparentBackground === true,
      inputFidelity: text(current.inputFidelity),
      timeoutMs: typeof current.timeoutMs === 'number' ? current.timeoutMs : 120000,
    }
  }
  return {
    provider: 'nano-banana',
    baseUrl: text(current.baseUrl) || 'https://openrouter.ai/api/v1',
    apiKey: text(current.apiKey),
    model: text(current.model) || 'google/gemini-3-pro-image-preview',
    aspectRatio: text(current.aspectRatio) || '2:3',
    imageSize: text(current.imageSize),
    quality: text(current.quality),
    timeoutMs: typeof current.timeoutMs === 'number' ? current.timeoutMs : 120000,
  }
}

export function ensureImageProfiles(cfg: JsonObj): Record<string, JsonObj> {
  cfg.image ??= {}
  if (!cfg.image.profiles || typeof cfg.image.profiles !== 'object') {
    const avatarProvider = text(cfg.avatarGen?.provider) === 'chatgpt-image' ? 'gpt-image-2' : 'nano-banana'
    const snapProvider = text(cfg.snap?.provider) === 'gpt-image-2' ? 'gpt-image-2' : 'nano-banana'
    cfg.image.profiles = {
      avatar: defaultImageProfile(avatarProvider, {
        ...cfg.avatarGen,
        provider: avatarProvider,
      }),
      snap: defaultImageProfile(snapProvider, {
        ...cfg.snap,
        provider: snapProvider,
      }),
    }
    cfg.image.default = cfg.image.default || 'avatar'
    cfg.image.avatarGenProfile ??= 'avatar'
    cfg.image.snapProfile ??= 'snap'
  }
  const profiles = cfg.image.profiles as Record<string, JsonObj>
  if (!Object.keys(profiles).length) {
    profiles.main = defaultImageProfile('nano-banana')
    cfg.image.default = 'main'
  }
  if (!cfg.image.default || !profiles[cfg.image.default]) cfg.image.default = Object.keys(profiles)[0]
  if (!cfg.image.avatarGenProfile || !profiles[cfg.image.avatarGenProfile]) cfg.image.avatarGenProfile = cfg.image.default
  if (!cfg.image.snapProfile || !profiles[cfg.image.snapProfile]) cfg.image.snapProfile = cfg.image.default
  return profiles
}

export function inferSharedModelsDir(cwd: string): string {
  const m = cwd.match(/^\/Users\/[^/]+\/Dev(?:\/|$)/)
  if (m) return `${m[0].replace(/\/$/, '')}/models`
  return `${cwd.replace(/\/+$/, '')}/models`
}

export function ensureDefaultConfigNodes(cfg: JsonObj, cwd: string): void {
  cfg.version = 1
  cfg.mcp ??= { servers: {} }
  cfg.compaction ??= { autoThresholdTokens: 30000 }
  cfg.liveUi ??= {}
  cfg.liveUi.port ??= 8080
  cfg.liveUi.subconsciousHeartbeatMs ??= 60000
  cfg.liveUi.figureZoom ??= 1
  cfg.liveUi.ttsAutoEnabled ??= true
  cfg.liveUi.asrAutoEnabled ??= false
  cfg.liveUi.asrMode ??= 'manual'
  cfg.liveUi.live2dModelsDir ??= './live2d-models'
  cfg.liveUi.live2dModelDict ??= './model_dict.json'
  cfg.liveUi.live2dModelName ??= 'mao_pro'
  cfg.liveUi.voiceMicSpeechRmsThreshold ??= 0.03
  cfg.liveUi.voiceMicSilenceEndMs ??= 1500
  cfg.liveUi.voiceMicSuppressInterruptDuringTts ??= true

  const modelsDir = inferSharedModelsDir(cwd)
  const senseVoiceDir = `${modelsDir}/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17`
  cfg.asr ??= {
    provider: 'sherpa_onnx',
    model: `${senseVoiceDir}/model.int8.onnx`,
    tokens: `${senseVoiceDir}/tokens.txt`,
    lang: 'auto',
    numThreads: 4,
  }

  ensureImageProfiles(cfg)
  delete cfg.avatarGen
  delete cfg.snap
  cfg.seedance ??= {
    provider: 'volcengine',
    baseUrl: 'https://ark.cn-beijing.volces.com',
    model: 'doubao-seedance-2-0-260128',
    ratio: '16:9',
    duration: 5,
    resolution: '720p',
    generateAudio: true,
    watermark: false,
    pollIntervalMs: 15000,
    timeoutMs: 900000,
  }
}

export function syncFlatLlm(cfg: JsonObj): void {
  const profiles = ensureLlmProfiles(cfg)
  const names = Object.keys(profiles)
  if (!names.includes(cfg.llm.default)) cfg.llm.default = names[0] || 'main'
  if (cfg.llm.metaAgentProfile && !names.includes(cfg.llm.metaAgentProfile)) {
    cfg.llm.metaAgentProfile = names.includes('gate') ? 'gate' : cfg.llm.default
  }
  if (cfg.llm.subconsciousProfile && !names.includes(cfg.llm.subconsciousProfile)) {
    delete cfg.llm.subconsciousProfile
  }
  const p = profiles[cfg.llm.default]
  if (!p) return
  cfg.llm.provider = p.provider
  cfg.llm.baseUrl = p.baseUrl
  cfg.llm.model = p.model
  cfg.llm.apiKey = p.apiKey
  if (p.disableTools !== undefined) cfg.llm.disableTools = !!p.disableTools
}
