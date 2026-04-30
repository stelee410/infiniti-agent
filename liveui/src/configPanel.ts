type JsonObj = Record<string, any>

type ConfigPanelOptions = {
  socket: WebSocket
  onOpenChange?: (open: boolean) => void
}

const tabs = [
  ['llm', 'LLM'],
  ['liveUi', 'LiveUI'],
  ['tts', 'TTS'],
  ['asr', 'ASR'],
  ['image', 'Image'],
  ['seedance', 'Seedance'],
] as const

const llmProviders = ['anthropic', 'openai', 'gemini', 'minimax', 'openrouter']
const imageProviders = ['gpt-image-2', 'nano-banana']
const ttsProviders = ['', 'mimo', 'voxcpm', 'moss_tts_nano', 'minimax', 'whisper']
const mimoTtsModels = ['mimo-v2.5-tts-voiceclone', 'mimo-v2.5-tts-voicedesign', 'mimo-v2.5-tts', 'mimo-v2-tts']

function cloneConfig(v: unknown): JsonObj {
  try {
    return JSON.parse(JSON.stringify(v ?? {}))
  } catch {
    return {}
  }
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown, fallback = ''): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : fallback
}

function lines(v: unknown): string {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string').join('\n') : ''
}

function splitLines(v: string): string[] {
  return v.split(/[\n,]/).map((x) => x.trim()).filter(Boolean)
}

function findMimoApiKey(cfg: JsonObj): string {
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

function defaultTtsConfig(provider: string, cfg: JsonObj): JsonObj | undefined {
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

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  for (const child of children) node.append(child)
  return node
}

function field(label: string, input: HTMLElement, span2 = false): HTMLDivElement {
  return el('div', { class: `config-field${span2 ? ' config-span-2' : ''}` }, [
    el('label', {}, [label]),
    input,
  ])
}

function input(value: string, onInput: (v: string) => void, type = 'text'): HTMLInputElement {
  const n = el('input') as HTMLInputElement
  n.type = type
  n.value = value
  n.addEventListener('input', () => onInput(n.value))
  return n
}

function commitInput(value: string, onCommit: (v: string) => void, type = 'text'): HTMLInputElement {
  const n = el('input') as HTMLInputElement
  n.type = type
  n.value = value
  n.addEventListener('change', () => onCommit(n.value))
  return n
}

function select(value: string, options: Array<[string, string]>, onChange: (v: string) => void): HTMLSelectElement {
  const n = el('select') as HTMLSelectElement
  for (const [v, label] of options) {
    const opt = el('option') as HTMLOptionElement
    opt.value = v
    opt.textContent = label
    n.append(opt)
  }
  n.value = value
  n.addEventListener('change', () => onChange(n.value))
  return n
}

function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = el('button', { type: 'button', class: `config-btn${primary ? ' config-btn--primary' : ''}` }, [label]) as HTMLButtonElement
  b.addEventListener('click', onClick)
  return b
}

async function pickPath(kind: 'file' | 'directory', defaultPath?: string): Promise<string | null> {
  return window.infinitiLiveUi?.selectPath?.({ kind, defaultPath }) ?? null
}

function ensureLlmProfiles(cfg: JsonObj): Record<string, JsonObj> {
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

function defaultImageProfile(provider: string, current: JsonObj = {}): JsonObj {
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

function ensureImageProfiles(cfg: JsonObj): Record<string, JsonObj> {
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

function inferSharedModelsDir(cwd: string): string {
  const m = cwd.match(/^\/Users\/[^/]+\/Dev(?:\/|$)/)
  if (m) return `${m[0].replace(/\/$/, '')}/models`
  return `${cwd.replace(/\/+$/, '')}/models`
}

function ensureDefaultConfigNodes(cfg: JsonObj, cwd: string): void {
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

function syncFlatLlm(cfg: JsonObj): void {
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

export function initConfigPanel(opts: ConfigPanelOptions): {
  open: (cwd: string, config: unknown) => void
  close: () => void
  setStatus: (ok: boolean, message: string) => void
} {
  const panel = document.getElementById('liveui-config-panel') as HTMLDivElement | null
  const tabsEl = document.getElementById('liveui-config-tabs') as HTMLElement | null
  const content = document.getElementById('liveui-config-content') as HTMLElement | null
  const pathEl = document.getElementById('liveui-config-path') as HTMLElement | null
  const statusEl = document.getElementById('liveui-config-status') as HTMLElement | null
  const closeBtn = document.getElementById('liveui-config-close') as HTMLButtonElement | null
  const saveBtn = document.getElementById('liveui-config-save') as HTMLButtonElement | null

  let cfg: JsonObj = {}
  let cwd = ''
  let active = 'llm'

  const setStatus = (ok: boolean, message: string): void => {
    if (!statusEl) return
    statusEl.textContent = message
    statusEl.className = ok ? 'ok' : 'err'
  }

  const close = (): void => {
    if (!panel) return
    panel.hidden = true
    panel.setAttribute('aria-hidden', 'true')
    opts.onOpenChange?.(false)
  }

  const open = (nextCwd: string, config: unknown): void => {
    cfg = cloneConfig(config)
    cwd = nextCwd
    ensureDefaultConfigNodes(cfg, cwd)
    active = 'llm'
    if (pathEl) pathEl.textContent = `${cwd}/.infiniti-agent/config.json`
    setStatus(true, '')
    render()
    if (!panel) return
    panel.hidden = false
    panel.setAttribute('aria-hidden', 'false')
    opts.onOpenChange?.(true)
  }

  const rerender = (): void => render()

  const renderTabs = (): void => {
    if (!tabsEl) return
    tabsEl.replaceChildren()
    for (const [id, label] of tabs) {
      const b = el('button', {
        type: 'button',
        class: `config-tab${active === id ? ' config-tab--active' : ''}`,
      }, [label]) as HTMLButtonElement
      b.addEventListener('pointerdown', (ev) => {
        ev.preventDefault()
        active = id
        render()
      })
      tabsEl.append(b)
    }
  }

  const render = (): void => {
    renderTabs()
    if (!content) return
    content.replaceChildren()
    if (active === 'llm') renderLlm(content)
    else if (active === 'liveUi') renderLiveUi(content)
    else if (active === 'tts') renderTts(content)
    else if (active === 'asr') renderAsr(content)
    else if (active === 'image') renderImage(content)
    else renderSeedance(content)
  }

  const renderLlm = (root: HTMLElement): void => {
    const section = el('section', { class: 'config-section config-section--active' })
    cfg.llm ??= {}
    const profiles = ensureLlmProfiles(cfg)
    const names = Object.keys(profiles)
    const defaultSelect = select(String(cfg.llm.default || names[0] || 'main'), names.map((n) => [n, n]), (v) => {
      cfg.llm.default = v
      syncFlatLlm(cfg)
      rerender()
    })
    section.append(field('当前使用的 provider profile', defaultSelect))
    const fallbackMetaProfile = names.includes('gate') ? 'gate' : cfg.llm.default || names[0] || 'main'
    const metaAgentProfile = String(
      cfg.llm.metaAgentProfile && names.includes(cfg.llm.metaAgentProfile)
        ? cfg.llm.metaAgentProfile
        : fallbackMetaProfile,
    )
    cfg.llm.metaAgentProfile = metaAgentProfile
    const metaSelect = select(metaAgentProfile, names.map((n) => [n, n]), (v) => {
      cfg.llm.metaAgentProfile = v
      rerender()
    })
    section.append(field('Meta-agent 使用的 provider profile', metaSelect))
    const subconsciousProfile = String(
      cfg.llm.subconsciousProfile && names.includes(cfg.llm.subconsciousProfile)
        ? cfg.llm.subconsciousProfile
        : '',
    )
    if (!subconsciousProfile) delete cfg.llm.subconsciousProfile
    const subconsciousOptions: Array<[string, string]> = [
      ['', '默认主 LLM'],
      ...names.map((n): [string, string] => [n, n]),
    ]
    const subconsciousSelect = select(subconsciousProfile, subconsciousOptions, (v) => {
      if (v) cfg.llm.subconsciousProfile = v
      else delete cfg.llm.subconsciousProfile
      rerender()
    })
    section.append(field('Subconscious-agent 使用的 provider profile', subconsciousSelect))
    const list = el('div', { class: 'config-list config-span-2' })
    for (const name of Object.keys(profiles)) {
      const p = profiles[name]
      const card = el('div', { class: 'config-card config-grid' })
      card.append(
        field('名称', commitInput(name, (v) => {
          const next = v.trim()
          if (!next || next === name || profiles[next]) return
          profiles[next] = profiles[name]
          delete profiles[name]
          if (cfg.llm.default === name) cfg.llm.default = next
          if (cfg.llm.metaAgentProfile === name) cfg.llm.metaAgentProfile = next
          if (cfg.llm.subconsciousProfile === name) cfg.llm.subconsciousProfile = next
          rerender()
        })),
        field('Provider', select(String(p.provider || 'openai'), llmProviders.map((x) => [x, x]), (v) => { p.provider = v; syncFlatLlm(cfg) })),
        field('Base URL', input(text(p.baseUrl), (v) => { p.baseUrl = v; syncFlatLlm(cfg) })),
        field('Model', input(text(p.model), (v) => { p.model = v; syncFlatLlm(cfg) })),
        field('API Key', input(text(p.apiKey), (v) => { p.apiKey = v; syncFlatLlm(cfg) }, 'password')),
        field('Disable tools', select(p.disableTools ? 'true' : 'false', [['false', '否'], ['true', '是']], (v) => { p.disableTools = v === 'true'; syncFlatLlm(cfg) })),
      )
      const del = button('删除', () => {
        if (Object.keys(profiles).length <= 1) {
          setStatus(false, '至少保留一个 LLM provider')
          return
        }
        delete profiles[name]
        if (cfg.llm.default === name) cfg.llm.default = Object.keys(profiles)[0]
        if (cfg.llm.metaAgentProfile === name) cfg.llm.metaAgentProfile = Object.keys(profiles)[0]
        if (cfg.llm.subconsciousProfile === name) cfg.llm.subconsciousProfile = Object.keys(profiles)[0]
        syncFlatLlm(cfg)
        rerender()
      })
      card.append(el('div', { class: 'config-row config-span-2' }, [del]))
      list.append(card)
    }
    section.append(list)
    section.append(button('添加 LLM provider', () => {
      let i = Object.keys(profiles).length + 1
      while (profiles[`provider${i}`]) i++
      profiles[`provider${i}`] = { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', apiKey: '' }
      rerender()
    }))
    root.append(section)
  }

  const pathField = (label: string, value: string, kind: 'file' | 'directory', set: (v: string) => void): HTMLDivElement => {
    const n = input(value, set)
    return field(label, el('div', { class: 'config-row' }, [
      n,
      button('...', () => void pickPath(kind, n.value.trim() || undefined).then((p) => {
        if (!p) return
        n.value = p
        set(p)
      })),
    ]), true)
  }

  const renderLiveUi = (root: HTMLElement): void => {
    cfg.liveUi ??= {}
    const l = cfg.liveUi
    const mode = l.renderer || (l.spriteExpressions?.dir ? 'sprite' : 'live2d')
    const section = el('section', { class: 'config-section config-section--active' })
    const grid = el('div', { class: 'config-grid' })
    grid.append(
      field('Heartbeat 间隔(ms)', input(num(l.subconsciousHeartbeatMs, '60000'), (v) => {
        const n = Number(v)
        if (Number.isFinite(n)) l.subconsciousHeartbeatMs = Math.round(n)
      }, 'number')),
      field('形象缩放比例', input(num(l.figureZoom, '1'), (v) => {
        const n = Number(v)
        if (Number.isFinite(n)) l.figureZoom = n
      }, 'number')),
      field('TTS 自动', select(l.ttsAutoEnabled === false ? 'false' : 'true', [['true', '开启'], ['false', '关闭']], (v) => { l.ttsAutoEnabled = v === 'true' })),
      field('ASR 自动', select(l.asrAutoEnabled ? 'true' : 'false', [['false', '关闭'], ['true', '开启']], (v) => { l.asrAutoEnabled = v === 'true' })),
      field('ASR 模式', select(text(l.asrMode || 'manual'), [['manual', '手动识别'], ['auto', '自动识别']], (v) => { l.asrMode = v })),
      field('角色渲染方式', select(mode, [['live2d', 'Live2D model3'], ['sprite', 'spriteExpressions'], ['real2d', 'real2d']], (v) => {
        l.renderer = v
        if (v === 'sprite' || v === 'real2d') l.spriteExpressions ??= {}
        else delete l.spriteExpressions
        rerender()
      })),
      field('voiceMicSpeechRmsThreshold', input(num(l.voiceMicSpeechRmsThreshold, '0.0195'), (v) => { l.voiceMicSpeechRmsThreshold = Number(v) }, 'number')),
    )
    if (mode === 'sprite' || mode === 'real2d') {
      l.spriteExpressions ??= {}
      grid.append(pathField('spriteExpressions 目录', text(l.spriteExpressions.dir), 'directory', (v) => { l.spriteExpressions.dir = v }))
      grid.append(pathField('expressions.json（可选）', text(l.spriteExpressions.manifest), 'file', (v) => { l.spriteExpressions.manifest = v }))
      if (mode === 'real2d') {
        grid.append(field('real2d 说明', el('div', { class: 'config-help' }, '默认读取 exp01.png 到 exp06.png；expressions.json 可覆盖 real2d 表情槽位；exp_open.png 可选，用于说话口型。')))
      }
    } else {
      grid.append(pathField('Live2D model3.json', text(l.live2dModel3Json), 'file', (v) => { l.live2dModel3Json = v }))
      grid.append(pathField('model_dict.json（可选）', text(l.live2dModelDict), 'file', (v) => { l.live2dModelDict = v }))
    }
    section.append(grid)
    root.append(section)
  }

  const renderTts = (root: HTMLElement): void => {
    cfg.tts ??= {}
    const t = cfg.tts
    const provider = text(t.provider)
    const section = el('section', { class: 'config-section config-section--active' })
    const grid = el('div', { class: 'config-grid' })
    grid.append(field('Provider', select(provider, ttsProviders.map((x) => [x, x || '未启用']), (v) => {
      cfg.tts = defaultTtsConfig(v, cfg)
      rerender()
    })))
    if (provider === 'minimax') {
      grid.append(
        field('API Key', input(text(t.apiKey), (v) => { t.apiKey = v }, 'password')),
        field('Group ID', input(text(t.groupId), (v) => { t.groupId = v })),
        field('Model', input(text(t.model || 'speech-02-turbo'), (v) => { t.model = v })),
        field('Voice ID', input(text(t.voiceId || 'female-shaonv'), (v) => { t.voiceId = v })),
        field('Speed', input(num(t.speed, '1'), (v) => { t.speed = Number(v) }, 'number')),
        field('刷新声音列表', button('刷新/显示常用声音', () => setStatus(true, '常用声音: female-shaonv, male-qn-qingse, female-tianmei, male-qn-jingying'))),
      )
    } else if (provider === 'whisper') {
      grid.append(
        field('Base URL', input(text(t.baseUrl), (v) => { t.baseUrl = v })),
        field('API Key', input(text(t.apiKey), (v) => { t.apiKey = v }, 'password')),
        field('Model', input(text(t.model), (v) => { t.model = v })),
        field('Voice ID', input(text(t.voiceId), (v) => { t.voiceId = v })),
        field('刷新声音列表', button('刷新/显示常用声音', () => setStatus(true, '常用声音: alloy, verse, aria, coral, sage'))),
      )
    } else if (provider === 'mimo') {
      grid.append(
        field('Base URL', input(text(t.baseUrl || 'https://token-plan-cn.xiaomimimo.com/v1'), (v) => { t.baseUrl = v })),
        field('API Key', input(text(t.apiKey), (v) => { t.apiKey = v }, 'password')),
        field('Model', select(text(t.model || 'mimo-v2.5-tts-voiceclone'), mimoTtsModels.map((x) => [x, x]), (v) => { t.model = v; rerender() })),
        field('Format', select(text(t.format || 'wav'), [['wav', 'wav'], ['mp3', 'mp3']], (v) => { t.format = v })),
        field('Control Instruction', input(text(t.controlInstruction || '自然、清晰、语速适中。'), (v) => { t.controlInstruction = v })),
        field('Timeout ms', input(num(t.timeoutMs, '120000'), (v) => { t.timeoutMs = Number(v) }, 'number')),
      )
      if (text(t.model || 'mimo-v2.5-tts-voiceclone') === 'mimo-v2.5-tts-voiceclone') {
        grid.append(
          pathField('Reference Audio', text(t.referenceAudioPath), 'file', (v) => { t.referenceAudioPath = v }),
          field('Reference Audio Base64', input(text(t.referenceAudioBase64), (v) => { t.referenceAudioBase64 = v }), true),
        )
      } else if (text(t.model) !== 'mimo-v2.5-tts-voicedesign') {
        grid.append(field('Voice ID', input(text(t.voiceId || 'mimo_default'), (v) => { t.voiceId = v })))
      }
    } else if (provider === 'moss_tts_nano') {
      grid.append(
        field('Base URL', input(text(t.baseUrl || 'http://127.0.0.1:18083'), (v) => { t.baseUrl = v })),
        field('Demo ID', input(text(t.demoId), (v) => { t.demoId = v })),
        pathField('Prompt Audio', text(t.promptAudioPath), 'file', (v) => { t.promptAudioPath = v }),
      )
    } else if (provider === 'voxcpm') {
      grid.append(
        field('Base URL', input(text(t.baseUrl || 'http://127.0.0.1:8810'), (v) => { t.baseUrl = v })),
        field('Control Instruction', input(text(t.controlInstruction), (v) => { t.controlInstruction = v })),
        pathField('Reference Audio', text(t.referenceAudioPath), 'file', (v) => { t.referenceAudioPath = v }),
      )
    }
    section.append(grid)
    root.append(section)
  }

  const renderAsr = (root: HTMLElement): void => {
    cfg.asr ??= { provider: 'sherpa_onnx' }
    const a = cfg.asr
    const provider = text(a.provider || 'sherpa_onnx')
    const section = el('section', { class: 'config-section config-section--active' })
    const grid = el('div', { class: 'config-grid' })
    grid.append(field('Provider', select(provider, [['sherpa_onnx', 'sherpa_onnx'], ['whisper', 'whisper']], (v) => {
      cfg.asr = v === 'whisper' ? { provider: 'whisper' } : { provider: 'sherpa_onnx' }
      rerender()
    })))
    if (provider === 'whisper') {
      grid.append(
        field('Base URL', input(text(a.baseUrl), (v) => { a.baseUrl = v })),
        field('API Key', input(text(a.apiKey), (v) => { a.apiKey = v }, 'password')),
        field('Model', input(text(a.model), (v) => { a.model = v })),
        field('Language', input(text(a.lang || 'zh'), (v) => { a.lang = v })),
      )
    } else {
      grid.append(
        pathField('模型 .onnx', text(a.model), 'file', (v) => { a.model = v }),
        pathField('tokens.txt', text(a.tokens), 'file', (v) => { a.tokens = v }),
        field('Language', input(text(a.lang || 'zh'), (v) => { a.lang = v })),
        field('Threads', input(num(a.numThreads, '4'), (v) => { a.numThreads = Number(v) }, 'number')),
      )
    }
    section.append(grid)
    root.append(section)
  }

  const renderImage = (root: HTMLElement): void => {
    const section = el('section', { class: 'config-section config-section--active' })
    const profiles = ensureImageProfiles(cfg)
    const names = Object.keys(profiles)
    section.append(field('Default image provider profile', select(String(cfg.image.default || names[0]), names.map((n) => [n, n]), (v) => {
      cfg.image.default = v
      rerender()
    })))
    section.append(field('AvatarGen image profile', select(String(cfg.image.avatarGenProfile || cfg.image.default || names[0]), names.map((n) => [n, n]), (v) => {
      cfg.image.avatarGenProfile = v
      rerender()
    })))
    section.append(field('Snap image profile', select(String(cfg.image.snapProfile || cfg.image.default || names[0]), names.map((n) => [n, n]), (v) => {
      cfg.image.snapProfile = v
      rerender()
    })))
    const list = el('div', { class: 'config-list config-span-2' })
    for (const name of names) {
      const p = profiles[name]
      const provider = text(p.provider || 'nano-banana')
      const card = el('div', { class: 'config-card config-grid' })
      card.append(
        field('名称', commitInput(name, (v) => {
          const next = v.trim()
          if (!next || next === name || profiles[next]) return
          profiles[next] = profiles[name]
          delete profiles[name]
          if (cfg.image.default === name) cfg.image.default = next
          if (cfg.image.avatarGenProfile === name) cfg.image.avatarGenProfile = next
          if (cfg.image.snapProfile === name) cfg.image.snapProfile = next
          rerender()
        })),
        field('Provider', select(provider, imageProviders.map((x) => [x, x]), (v) => {
          Object.assign(p, defaultImageProfile(v, p))
          p.provider = v
          rerender()
        })),
        field('Base URL', input(text(p.baseUrl), (v) => { p.baseUrl = v })),
        field('API Key', input(text(p.apiKey), (v) => { p.apiKey = v }, 'password')),
        field('Model', input(text(p.model), (v) => { p.model = v })),
      )
      if (provider === 'gpt-image-2') {
        card.append(
          field('Image Size', input(text(p.imageSize || '1024x1536'), (v) => { p.imageSize = v })),
          field('Quality', select(text(p.quality || 'high'), [['high', 'high'], ['medium', 'medium'], ['auto', 'auto'], ['low', 'low']], (v) => { p.quality = v })),
          field('Transparent Background', select(p.transparentBackground ? 'true' : 'false', [['false', 'Disabled'], ['true', 'Enabled']], (v) => { p.transparentBackground = v === 'true' })),
          field('Input Fidelity', select(text(p.inputFidelity || ''), [['', 'Disabled'], ['high', 'high'], ['low', 'low']], (v) => { if (v) p.inputFidelity = v; else delete p.inputFidelity })),
          field('Timeout ms', input(num(p.timeoutMs, '120000'), (v) => { p.timeoutMs = Number(v) }, 'number')),
        )
      } else {
        card.append(
          field('Aspect Ratio', input(text(p.aspectRatio || '2:3'), (v) => { p.aspectRatio = v })),
          field('Image Size', input(text(p.imageSize), (v) => { p.imageSize = v })),
          field('Quality', select(text(p.quality || ''), [['', 'default'], ['auto', 'auto'], ['high', 'high'], ['medium', 'medium'], ['low', 'low']], (v) => { if (v) p.quality = v; else delete p.quality })),
          field('Timeout ms', input(num(p.timeoutMs, '120000'), (v) => { p.timeoutMs = Number(v) }, 'number')),
        )
      }
      const del = button('删除', () => {
        if (Object.keys(profiles).length <= 1) {
          setStatus(false, '至少保留一个 Image provider')
          return
        }
        delete profiles[name]
        const first = Object.keys(profiles)[0]
        if (cfg.image.default === name) cfg.image.default = first
        if (cfg.image.avatarGenProfile === name) cfg.image.avatarGenProfile = first
        if (cfg.image.snapProfile === name) cfg.image.snapProfile = first
        rerender()
      })
      card.append(el('div', { class: 'config-row config-span-2' }, [del]))
      list.append(card)
    }
    section.append(list)
    section.append(button('添加 Image provider', () => {
      let i = Object.keys(profiles).length + 1
      while (profiles[`image${i}`]) i++
      profiles[`image${i}`] = defaultImageProfile('nano-banana')
      rerender()
    }))
    root.append(section)
  }

  const renderSeedance = (root: HTMLElement): void => {
    cfg.seedance ??= {}
    const s = cfg.seedance
    const section = el('section', { class: 'config-section config-section--active' })
    const grid = el('div', { class: 'config-grid' })
    grid.append(
      field('Provider', select(text(s.provider || 'volcengine'), [['volcengine', 'volcengine']], (v) => { s.provider = v })),
      field('Base URL', input(text(s.baseUrl), (v) => { s.baseUrl = v })),
      field('API Key', input(text(s.apiKey), (v) => { s.apiKey = v }, 'password')),
      field('Model', input(text(s.model), (v) => { s.model = v })),
      field('Ratio', input(text(s.ratio), (v) => { s.ratio = v })),
      field('Duration', input(num(s.duration, '5'), (v) => { s.duration = Number(v) }, 'number')),
      field('Resolution', input(text(s.resolution), (v) => { s.resolution = v })),
      field('Generate Audio', select(s.generateAudio === false ? 'false' : 'true', [['true', 'true'], ['false', 'false']], (v) => { s.generateAudio = v === 'true' })),
      field('Watermark', select(s.watermark ? 'true' : 'false', [['false', 'false'], ['true', 'true']], (v) => { s.watermark = v === 'true' })),
      field('Poll Interval ms', input(num(s.pollIntervalMs, '15000'), (v) => { s.pollIntervalMs = Number(v) }, 'number')),
      field('Timeout ms', input(num(s.timeoutMs, '900000'), (v) => { s.timeoutMs = Number(v) }, 'number')),
      field('Reference Image URLs', input(lines(s.referenceImageUrls), (v) => { s.referenceImageUrls = splitLines(v) }), true),
      field('Reference Video URLs', input(lines(s.referenceVideoUrls), (v) => { s.referenceVideoUrls = splitLines(v) }), true),
      field('Reference Audio URLs', input(lines(s.referenceAudioUrls), (v) => { s.referenceAudioUrls = splitLines(v) }), true),
    )
    section.append(grid)
    root.append(section)
  }

  closeBtn?.addEventListener('click', close)
  saveBtn?.addEventListener('click', () => {
    ensureDefaultConfigNodes(cfg, cwd)
    syncFlatLlm(cfg)
    opts.socket.send(JSON.stringify({ type: 'CONFIG_SAVE', data: { config: cfg } }))
    setStatus(true, '保存中…')
  })

  return { open, close, setStatus }
}
