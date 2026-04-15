import * as PIXI from 'pixi.js'
import { Live2DModel, cubism4Ready } from 'pixi-live2d-display/cubism4'
import {
  createStreamLiveUiState,
  processAssistantStreamChunk,
  stripLiveUiKnownEmotionTagsEverywhere,
  type StreamLiveUiState,
} from '../../src/liveui/emotionParse.ts'
import type { LiveUiStatusVariant } from '../../src/liveui/protocol.ts'
import { FIGURE_LAYOUT } from './figureLayoutConfig.ts'
import {
  HIT_BODY_RE,
  HIT_HEAD_RE,
  LIVE2D_BODY_POKE_MOTIONS,
  LIVE2D_IDLE,
} from './interactionConfig.ts'

declare global {
  interface Window {
    infinitiLiveUi?: {
      port: string
      model3FileUrl: string
      setIgnoreMouseEvents?: (ignore: boolean, opts?: { forward?: boolean }) => void
    }
    /** pixi-live2d-display 依赖全局 PIXI.Ticker */
    PIXI: typeof PIXI
  }
}

type SyncParam = {
  type: 'SYNC_PARAM'
  data: { id: 'ParamMouthOpenY'; value: number }
}

type ActionMsg = {
  type: 'ACTION'
  data: { expression?: string; motion?: string }
}

type AssistantStreamMsg = {
  type: 'ASSISTANT_STREAM'
  data: { fullRaw: string; reset?: boolean }
}

type StatusPillMsg = {
  type: 'STATUS_PILL'
  data: { label: string; variant: LiveUiStatusVariant }
}

type AudioChunkMsg = {
  type: 'AUDIO_CHUNK'
  data: { audioBase64: string; format: string; sampleRate: number; sequence: number }
}

type AudioResetMsg = { type: 'AUDIO_RESET' }

type TtsStatusMsg = { type: 'TTS_STATUS'; data: { available: boolean } }

type Msg = SyncParam | ActionMsg | AssistantStreamMsg | StatusPillMsg | AudioChunkMsg | AudioResetMsg | TtsStatusMsg

const FACE_RADIUS = 110

function readPort(): string {
  const fromPreload = window.infinitiLiveUi?.port?.trim()
  if (fromPreload) return fromPreload
  return new URLSearchParams(window.location.search).get('port') ?? '8080'
}

/** 将 TUI 情感名映射到 mao_pro 等模型的 expression 名（model3 内 Name 字段） */
function emotionToExpressionId(em: string): string {
  const e = em.toLowerCase().trim()
  const map: Record<string, string> = {
    happy: 'exp_03',
    joy: 'exp_03',
    sad: 'exp_02',
    sadness: 'exp_02',
    neutral: 'exp_01',
    calm: 'exp_01',
    thinking: 'exp_05',
    think: 'exp_05',
    angry: 'exp_06',
    anger: 'exp_06',
    surprised: 'exp_07',
    surprise: 'exp_07',
    frown: 'exp_08',
    smirk: 'exp_04',
    disgust: 'exp_04',
    blush: 'exp_04',
    fear: 'exp_02',
  }
  return map[e] ?? 'exp_01'
}

/**
 * 从 model3.json 的 Groups 中提取 LipSync 参数名列表。
 * 不同模型可能用 ParamMouthOpenY / ParamA / 其他名字。
 */
function getLipSyncParamIds(model: InstanceType<typeof Live2DModel>): string[] {
  try {
    const im = model.internalModel as {
      settings?: { groups?: Array<{ Name?: string; Ids?: string[] }> }
    }
    const groups = im?.settings?.groups
    if (groups) {
      const ls = groups.find((g) => g.Name === 'LipSync')
      if (ls?.Ids?.length) return ls.Ids
    }
  } catch { /* fallback */ }
  return ['ParamMouthOpenY']
}

const lipSyncParamCache = new WeakMap<InstanceType<typeof Live2DModel>, string[]>()

function setMouthFromModel(model: InstanceType<typeof Live2DModel>, value01: number): void {
  const im = model.internalModel as { coreModel?: { setParameterValueById?: (id: string, v: number) => void } }
  const core = im?.coreModel
  if (!core || typeof core.setParameterValueById !== 'function') return

  let paramIds = lipSyncParamCache.get(model)
  if (!paramIds) {
    paramIds = getLipSyncParamIds(model)
    lipSyncParamCache.set(model, paramIds)
    console.debug('[liveui] LipSync 参数:', paramIds)
  }

  const v = Math.max(0, Math.min(1, value01))
  for (const id of paramIds) {
    try {
      core.setParameterValueById(id, v)
    } catch { /* 忽略不存在的参数 */ }
  }
}

async function bootstrap(): Promise<void> {
  const canvas = document.getElementById('app') as HTMLCanvasElement | null
  const speechBubble = document.getElementById('speech-bubble')
  const speechBubbleText = document.getElementById('speech-bubble-text')
  const statusPill = document.getElementById('liveui-status-pill')
  const userLineInput = document.getElementById('liveui-user-line') as HTMLTextAreaElement | null
  if (!canvas) return

  window.PIXI = PIXI
  /* 必须传入 Ticker 类；插件内部使用 tickerRef.shared.add（传 Ticker.shared 会 undefined） */
  Live2DModel.registerTicker(PIXI.Ticker)

  const app = new PIXI.Application({
    view: canvas,
    width: window.innerWidth,
    height: window.innerHeight,
    backgroundAlpha: 0,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  })

  const face = new PIXI.Graphics()
  face.beginFill(0x6ec5ff, 0.85)
  face.drawCircle(0, 0, FACE_RADIUS)
  face.endFill()
  face.position.set(app.screen.width / 2, app.screen.height / 2 - 20)
  face.interactive = true
  face.cursor = 'pointer'
  face.hitArea = new PIXI.Circle(0, 0, FACE_RADIUS)

  const mouth = new PIXI.Graphics()
  mouth.position.set(face.x, face.y + 38)

  let liveModel: InstanceType<typeof Live2DModel> | null = null

  const layoutFootGapPx = (viewH: number): number =>
    Math.max(0, Math.round(viewH * FIGURE_LAYOUT.footGapScreenFraction))

  /**
   * 人物始终站在控制条（输入框）上方；气泡独立浮层，不影响人物位置。
   */
  const layoutFigureInStage = (): void => {
    const W = app.screen.width
    const H = app.screen.height
    const gap = layoutFootGapPx(H)
    const canvasRect = canvas.getBoundingClientRect()
    const controlBar = document.getElementById('liveui-control-bar')
    const controlBarTop = controlBar
      ? controlBar.getBoundingClientRect().top - canvasRect.top
      : H
    const soleCeiling = controlBarTop - FIGURE_LAYOUT.footClearOfControlBarPx

    const dock = document.getElementById('liveui-bottom-dock')
    const fallbackPlatform =
      dock != null
        ? dock.getBoundingClientRect().top - canvasRect.top
        : Math.max(120, H - Math.ceil(window.innerHeight * FIGURE_LAYOUT.fallbackDockReserveScreenFraction))
    const platformTop = controlBar != null ? controlBarTop : fallbackPlatform

    const stand = FIGURE_LAYOUT.footStandOnOverlapPx
    const targetFootY = platformTop + stand - gap

    const footNudgeMax = Math.min(
      FIGURE_LAYOUT.footNudgeMaxPx,
      Math.round(H * FIGURE_LAYOUT.footNudgeScreenFraction),
    )

    if (liveModel) {
      const uw = liveModel.width || 400
      const uh = liveModel.height || 600
      const maxBodyH = Math.max(100, Math.min(soleCeiling, targetFootY + footNudgeMax))
      const s = Math.min(
        (W * FIGURE_LAYOUT.modelWidthScreenFraction) / uw,
        (maxBodyH * FIGURE_LAYOUT.modelHeightScaleFraction) / uh,
      )
      liveModel.scale.set(s, s)
      liveModel.position.set(W / 2, H / 2)
      const b = liveModel.getBounds()
      liveModel.position.y += targetFootY - b.bottom
      liveModel.position.y += footNudgeMax
      const b2 = liveModel.getBounds()
      if (b2.bottom > soleCeiling) {
        liveModel.position.y -= b2.bottom - soleCeiling
      }
    } else {
      let fy = targetFootY - FACE_RADIUS + footNudgeMax
      if (fy + FACE_RADIUS > soleCeiling) {
        fy = soleCeiling - FACE_RADIUS
      }
      face.position.set(W / 2, fy)
      mouth.position.set(face.x, face.y + 38)
    }
  }
  let mouthOpen = 0
  let expression = 'neutral'

  const redrawPlaceholderMouth = (): void => {
    mouth.clear()
    const w = 36 + mouthOpen * 48
    const h = 6 + mouthOpen * 22
    mouth.beginFill(0x2a1a1a, 0.95)
    mouth.drawRoundedRect(-w / 2, -h / 2, w, h, Math.min(12, h / 2))
    mouth.endFill()
  }

  const applyPlaceholderExpression = (expr: string): void => {
    expression = expr
    const palette: Record<string, number> = {
      happy: 0xffe066,
      sad: 0x8899cc,
      angry: 0xff6666,
      thinking: 0xb388ff,
      neutral: 0x6ec5ff,
      surprised: 0x99ffcc,
      frown: 0xaaaaaa,
      blush: 0xffb3c6,
    }
    const fill = palette[expr] ?? 0x6ec5ff
    face.clear()
    face.beginFill(fill, 0.88)
    face.drawCircle(0, 0, FACE_RADIUS)
    face.endFill()
  }

  let assistantStreamState: StreamLiveUiState = createStreamLiveUiState()
  let typewriterRaf: number | undefined
  let bubbleTarget = ''
  let bubbleShown = 0
  let bubbleAutoDismissTimer: ReturnType<typeof setTimeout> | undefined
  let bubbleIsStreaming = false

  /** 将气泡定位到控制条上方、叠在人物躯干区域。 */
  const positionBubbleOverFigure = (): void => {
    if (!speechBubble) return
    const controlBar = document.getElementById('liveui-control-bar')
    if (!controlBar) return
    const barRect = controlBar.getBoundingClientRect()
    const gap = 12
    speechBubble.style.bottom = `${window.innerHeight - barRect.top + gap}px`
  }

  /** 根据文字量估算阅读时间（毫秒）：中文约 5 字/秒，英文约 4 词/秒，最少 3 秒，最多 15 秒。 */
  const estimateReadTimeMs = (text: string): number => {
    const chars = text.replace(/\s+/g, '').length
    const ms = Math.max(3000, Math.min(15000, chars * 200))
    return ms
  }

  const clearBubbleDismiss = (): void => {
    if (bubbleAutoDismissTimer !== undefined) {
      clearTimeout(bubbleAutoDismissTimer)
      bubbleAutoDismissTimer = undefined
    }
  }

  const scheduleBubbleDismiss = (): void => {
    clearBubbleDismiss()
    if (!bubbleTarget.trim()) return
    const ms = estimateReadTimeMs(bubbleTarget)
    bubbleAutoDismissTimer = setTimeout(() => {
      speechBubble?.classList.remove('visible')
      speechBubble?.setAttribute('aria-hidden', 'true')
      bubbleAutoDismissTimer = undefined
    }, ms)
  }

  const stopTypewriter = (): void => {
    if (typewriterRaf !== undefined) {
      cancelAnimationFrame(typewriterRaf)
      typewriterRaf = undefined
    }
  }

  const resetSpeechBubble = (): void => {
    stopTypewriter()
    clearBubbleDismiss()
    bubbleTarget = ''
    bubbleShown = 0
    bubbleIsStreaming = true
    if (speechBubbleText) speechBubbleText.textContent = ''
    speechBubble?.classList.remove('visible')
    speechBubble?.setAttribute('aria-hidden', 'true')
  }

  const runTypewriterFrame = (): void => {
    if (bubbleShown >= bubbleTarget.length) {
      typewriterRaf = undefined
      return
    }
    bubbleShown = Math.min(bubbleShown + 2, bubbleTarget.length)
    if (speechBubbleText) speechBubbleText.textContent = bubbleTarget.slice(0, bubbleShown)
    speechBubble?.classList.add('visible')
    speechBubble?.setAttribute('aria-hidden', 'false')
    positionBubbleOverFigure()
    typewriterRaf = requestAnimationFrame(runTypewriterFrame)
  }

  const ensureTypewriter = (): void => {
    if (typewriterRaf !== undefined) return
    if (!speechBubbleText) return
    typewriterRaf = requestAnimationFrame(runTypewriterFrame)
  }

  const setBubbleFromDisplayText = (displayText: string): void => {
    if (!speechBubbleText || !speechBubble) return
    bubbleTarget = displayText
    if (!displayText.trim()) {
      resetSpeechBubble()
      return
    }
    clearBubbleDismiss()
    if (bubbleShown > bubbleTarget.length) bubbleShown = bubbleTarget.length
    speechBubble.classList.add('visible')
    speechBubble.setAttribute('aria-hidden', 'false')
    positionBubbleOverFigure()
    ensureTypewriter()
  }

  const applyLive2dExpression = (em: string): void => {
    expression = em
    if (liveModel) {
      const expId = emotionToExpressionId(em)
      void liveModel.expression(expId).catch(() => {
        void liveModel!.expression(0).catch(() => {})
      })
    } else {
      applyPlaceholderExpression(em)
    }
  }

  const modelUrl = window.infinitiLiveUi?.model3FileUrl?.trim() ?? ''

  const wireHover = (target: PIXI.Container): void => {
    target.interactive = true
    target.cursor = 'default'
  }

  if (modelUrl) {
    try {
      await cubism4Ready()
      const model = await Live2DModel.from(modelUrl, { autoInteract: false })
      liveModel = model
      app.stage.removeChild(face)
      app.stage.removeChild(mouth)
      liveModel.anchor.set(0.5, 0.5)
      app.stage.addChild(liveModel)
      layoutFigureInStage()
      wireHover(liveModel)
      void liveModel.motion('Idle', 0).catch(() => {})
      console.debug('[liveui] Live2D Cubism4 模型已加载', modelUrl)
    } catch (e) {
      console.warn('[liveui] Live2D 加载失败，使用占位圆形:', e)
      liveModel = null
      app.stage.addChild(face)
      app.stage.addChild(mouth)
      applyPlaceholderExpression('neutral')
      redrawPlaceholderMouth()
      wireHover(face)
      layoutFigureInStage()
    }
  } else {
    app.stage.addChild(face)
    app.stage.addChild(mouth)
    applyPlaceholderExpression('neutral')
    redrawPlaceholderMouth()
    wireHover(face)
    layoutFigureInStage()
  }

  window.addEventListener('resize', () => {
    app.renderer.resize(window.innerWidth, window.innerHeight)
    layoutFigureInStage()
    positionBubbleOverFigure()
  })

  const dockEl = document.getElementById('liveui-bottom-dock')
  if (dockEl && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        layoutFigureInStage()
        positionBubbleOverFigure()
      })
    })
    ro.observe(dockEl)
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => layoutFigureInStage())
  })

  const port = readPort()
  const wsUrl = `ws://127.0.0.1:${port}`
  const socket = new WebSocket(wsUrl)

  let lastConvActivity = Date.now()
  let statusPillVariant: LiveUiStatusVariant = 'ready'
  let idleMotionBusy = false

  const touchConvActivity = (): void => {
    lastConvActivity = Date.now()
  }

  const sendLiveUiInteraction = (kind: 'head_pat' | 'body_poke'): void => {
    touchConvActivity()
    if (socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ type: 'LIVEUI_INTERACTION', data: { kind } }))
  }

  const classifyHitNames = (hits: string[]): 'head' | 'body' | null => {
    for (const id of hits) {
      if (HIT_HEAD_RE.test(id)) return 'head'
    }
    for (const id of hits) {
      if (HIT_BODY_RE.test(id)) return 'body'
    }
    return null
  }

  async function tryBodyPokeMotion(model: InstanceType<typeof Live2DModel>): Promise<void> {
    for (const m of LIVE2D_BODY_POKE_MOTIONS) {
      const ok = await model.motion(m.group, m.index).catch(() => false)
      if (ok) return
    }
  }

  const wirePointerInteractions = (): void => {
    if (liveModel) {
      liveModel.cursor = 'pointer'
      liveModel.on('pointertap', (e: PIXI.InteractionEvent) => {
        const gp = e.data.global
        const hits = liveModel!.hitTest(gp.x, gp.y)
        let zone = classifyHitNames(hits)
        if (!zone && liveModel!.containsPoint(gp)) {
          const lp = e.data.getLocalPosition(liveModel!)
          zone = lp.y < 0 ? 'head' : 'body'
        }
        if (zone === 'head') {
          applyLive2dExpression('blush')
          sendLiveUiInteraction('head_pat')
        } else if (zone === 'body') {
          applyLive2dExpression('angry')
          void tryBodyPokeMotion(liveModel!)
          sendLiveUiInteraction('body_poke')
        }
      })
    } else {
      face.cursor = 'pointer'
      face.on('pointertap', (e: PIXI.InteractionEvent) => {
        const lp = e.data.getLocalPosition(face)
        const head = lp.y < -FACE_RADIUS * 0.22
        applyLive2dExpression(head ? 'blush' : 'angry')
        sendLiveUiInteraction(head ? 'head_pat' : 'body_poke')
      })
    }
  }

  // ── TTS 开关 ──
  let ttsEnabled = true
  let ttsAvailable = false

  // ── 音频播放系统（TTS AUDIO_CHUNK） ──
  let audioCtx: AudioContext | null = null
  let audioPlaying = false
  const audioQueue: ArrayBuffer[] = []
  let audioMouthRaf: number | undefined
  let audioSource: AudioBufferSourceNode | null = null
  let audioAnalyser: AnalyserNode | null = null
  const audioAnalyserData = new Uint8Array(256)
  let ttsActive = false

  const ensureAudioCtx = (): AudioContext => {
    if (!audioCtx) {
      audioCtx = new AudioContext()
      console.debug('[liveui] AudioContext 已创建, state:', audioCtx.state)
    }
    if (audioCtx.state === 'suspended') {
      void audioCtx.resume().then(() => {
        console.debug('[liveui] AudioContext resumed')
      })
    }
    return audioCtx
  }

  const setMouthFromAudio = (): void => {
    if (!audioAnalyser) return
    audioAnalyser.getByteTimeDomainData(audioAnalyserData)
    let sum = 0
    for (let i = 0; i < audioAnalyserData.length; i++) {
      const v = (audioAnalyserData[i]! - 128) / 128
      sum += v * v
    }
    const rms = Math.sqrt(sum / audioAnalyserData.length)
    const open = Math.min(1, rms * 3.5)
    mouthOpen = open
    if (liveModel) {
      setMouthFromModel(liveModel, open)
    } else {
      redrawPlaceholderMouth()
    }
    if (audioPlaying) {
      audioMouthRaf = requestAnimationFrame(setMouthFromAudio)
    }
  }

  const playNextInQueue = (): void => {
    if (audioPlaying || audioQueue.length === 0) return
    const buf = audioQueue.shift()!
    audioPlaying = true
    ttsActive = true
    const ctx = ensureAudioCtx()

    void ctx.decodeAudioData(buf).then((decoded) => {
      console.debug(`[liveui] 音频解码成功: ${decoded.duration.toFixed(2)}s, sampleRate: ${decoded.sampleRate}`)
      const src = ctx.createBufferSource()
      src.buffer = decoded
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      src.connect(analyser)
      analyser.connect(ctx.destination)
      audioSource = src
      audioAnalyser = analyser
      audioMouthRaf = requestAnimationFrame(setMouthFromAudio)
      src.onended = () => {
        audioPlaying = false
        audioSource = null
        audioAnalyser = null
        if (audioMouthRaf) cancelAnimationFrame(audioMouthRaf)
        audioMouthRaf = undefined
        mouthOpen = 0
        if (liveModel) setMouthFromModel(liveModel, 0)
        else redrawPlaceholderMouth()
        if (audioQueue.length > 0) {
          playNextInQueue()
        } else {
          ttsActive = false
        }
      }
      src.start()
    }).catch((e) => {
      console.warn('[liveui] 音频解码失败:', e)
      audioPlaying = false
      ttsActive = false
      playNextInQueue()
    })
  }

  const enqueueAudioChunk = (base64: string): void => {
    const bin = atob(base64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    console.debug(`[liveui] 收到音频块: ${bytes.length} bytes, 队列: ${audioQueue.length}`)
    audioQueue.push(bytes.buffer)
    playNextInQueue()
  }

  const resetAudioQueue = (): void => {
    audioQueue.length = 0
    if (audioSource) {
      try { audioSource.stop() } catch { /* ignore */ }
      audioSource = null
    }
    audioPlaying = false
    ttsActive = false
    if (audioMouthRaf) cancelAnimationFrame(audioMouthRaf)
    audioMouthRaf = undefined
    audioAnalyser = null
  }

  socket.addEventListener('open', () => {
    console.debug('[liveui] WebSocket 已连接', wsUrl)
    touchConvActivity()
  })
  socket.addEventListener('close', () => {
    console.debug('[liveui] WebSocket 已断开')
  })
  socket.addEventListener('error', () => {
    console.warn('[liveui] WebSocket 错误')
  })

  socket.addEventListener('message', (ev) => {
    let msg: Msg
    try {
      msg = JSON.parse(String(ev.data)) as Msg
    } catch {
      return
    }
    if (msg.type === 'SYNC_PARAM' && msg.data?.id === 'ParamMouthOpenY') {
      if (!ttsActive) {
        mouthOpen = Math.max(0, Math.min(1, Number(msg.data.value) || 0))
        if (liveModel) {
          setMouthFromModel(liveModel, mouthOpen)
        } else {
          redrawPlaceholderMouth()
        }
      }
    } else if (msg.type === 'TTS_STATUS') {
      ttsAvailable = !!msg.data?.available
      updateSpeakerBtn()
    } else if (msg.type === 'AUDIO_CHUNK') {
      if (ttsEnabled) enqueueAudioChunk(msg.data.audioBase64)
    } else if (msg.type === 'AUDIO_RESET') {
      resetAudioQueue()
    } else if (msg.type === 'ACTION') {
      const em = msg.data?.expression
      if (em) applyLive2dExpression(em)
      const motion = msg.data?.motion
      if (motion && liveModel) {
        console.debug('[liveui] motion 指令（可扩展 motion 组映射）:', motion)
      }
    } else if (msg.type === 'ASSISTANT_STREAM') {
      const fullRaw = typeof msg.data?.fullRaw === 'string' ? msg.data.fullRaw : ''
      if (msg.data?.reset) {
        assistantStreamState = createStreamLiveUiState()
        resetSpeechBubble()
      }
      const { displayText, newActions } = processAssistantStreamChunk(assistantStreamState, fullRaw)
      for (const a of newActions) {
        if (a.expression) applyLive2dExpression(a.expression)
      }
      setBubbleFromDisplayText(stripLiveUiKnownEmotionTagsEverywhere(displayText))
      touchConvActivity()
    } else if (msg.type === 'STATUS_PILL' && statusPill) {
      const label = typeof msg.data?.label === 'string' ? msg.data.label : '就绪'
      const v = msg.data?.variant
      const variant: LiveUiStatusVariant =
        v === 'ready' || v === 'busy' || v === 'warn' || v === 'loading' ? v : 'ready'
      const wasBusy = statusPillVariant === 'busy' || statusPillVariant === 'loading'
      statusPillVariant = variant
      statusPill.textContent = label
      statusPill.className = `liveui-status-pill liveui-status-pill--${variant}`
      if (wasBusy && variant === 'ready' && bubbleTarget.trim()) {
        bubbleIsStreaming = false
        scheduleBubbleDismiss()
      }
    }
  })

  userLineInput?.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing) return
    ev.preventDefault()
    const v = userLineInput.value.trimEnd()
    if (!v.trim()) return
    if (socket.readyState !== WebSocket.OPEN) return
    touchConvActivity()
    socket.send(JSON.stringify({ type: 'USER_INPUT', data: { line: v } }))
    userLineInput.value = ''
  })

  wirePointerInteractions()

  setInterval(() => {
    if (!liveModel || statusPillVariant !== 'ready' || idleMotionBusy) return
    if (Date.now() - lastConvActivity < LIVE2D_IDLE.idleSeconds * 1000) return
    idleMotionBusy = true
    void (async () => {
      const pool = [...LIVE2D_IDLE.motionPool].sort(() => Math.random() - 0.5)
      for (const { group, index } of pool) {
        const ok = await liveModel.motion(group, index).catch(() => false)
        if (ok) break
      }
      idleMotionBusy = false
      touchConvActivity()
    })()
  }, LIVE2D_IDLE.pollIntervalMs)

  // ── 喇叭按钮：TTS 开关 ──
  const speakerBtn = document.getElementById('liveui-btn-speaker') as HTMLButtonElement | null
  const speakerIconOn = document.getElementById('liveui-speaker-icon-on')
  const speakerIconOff = document.getElementById('liveui-speaker-icon-off')

  const updateSpeakerBtn = (): void => {
    if (!speakerBtn) return
    const on = ttsEnabled && ttsAvailable
    speakerBtn.setAttribute('aria-pressed', String(on))
    speakerBtn.title = on ? '语音回复：已开启' : (ttsAvailable ? '语音回复：已关闭' : '语音回复：不可用')
    if (speakerIconOn) speakerIconOn.style.display = on ? '' : 'none'
    if (speakerIconOff) speakerIconOff.style.display = on ? 'none' : ''
  }

  speakerBtn?.addEventListener('click', () => {
    if (!ttsAvailable) return
    ttsEnabled = !ttsEnabled
    updateSpeakerBtn()
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'TTS_TOGGLE', data: { enabled: ttsEnabled } }))
    }
    if (!ttsEnabled) resetAudioQueue()
  })

  document.getElementById('liveui-btn-mute')?.addEventListener('click', () => {
    console.debug('[liveui] toolbar placeholder: liveui-btn-mute')
  })

  // ── 手掌按钮：随机动作 ──
  let randomMotionBusy = false
  document.getElementById('liveui-btn-hand')?.addEventListener('click', () => {
    if (!liveModel || randomMotionBusy) return
    randomMotionBusy = true
    const im = liveModel.internalModel as {
      settings?: { motions?: Record<string, unknown[]> }
    }
    const motionDefs = im?.settings?.motions
    const allMotions: { group: string; index: number }[] = []
    if (motionDefs) {
      for (const [group, items] of Object.entries(motionDefs)) {
        if (Array.isArray(items)) {
          for (let i = 0; i < items.length; i++) {
            allMotions.push({ group, index: i })
          }
        }
      }
    }
    if (allMotions.length === 0) {
      randomMotionBusy = false
      return
    }
    const pick = allMotions[Math.floor(Math.random() * allMotions.length)]!
    console.debug(`[liveui] 随机动作: ${pick.group || '(default)'}[${pick.index}]`)
    void liveModel.motion(pick.group, pick.index).catch(() => {}).finally(() => {
      randomMotionBusy = false
    })
  })

  app.ticker.add(() => {
    if (!liveModel) {
      const t = performance.now() / 1000
      face.scale.set(1 + Math.sin(t * 2.2) * 0.012)
    }
  })

  // ── macOS 透明窗口：动态切换鼠标穿透 ──
  const setIgnore = window.infinitiLiveUi?.setIgnoreMouseEvents
  if (setIgnore) {
    let windowIgnoring = true

    const isOverInteractive = (ex: number, ey: number): boolean => {
      const dom = document.elementFromPoint(ex, ey)
      if (dom && dom.closest('#liveui-control-bar')) return true
      if (liveModel) {
        const b = liveModel.getBounds()
        if (ex >= b.x && ex <= b.x + b.width && ey >= b.y && ey <= b.y + b.height) return true
      } else {
        const dx = ex - face.x
        const dy = ey - face.y
        if (dx * dx + dy * dy <= FACE_RADIUS * FACE_RADIUS) return true
      }
      return false
    }

    document.addEventListener('mousemove', (e) => {
      const shouldCapture = isOverInteractive(e.clientX, e.clientY)
      if (shouldCapture && windowIgnoring) {
        windowIgnoring = false
        setIgnore(false)
      } else if (!shouldCapture && !windowIgnoring) {
        windowIgnoring = true
        setIgnore(true, { forward: true })
      }
    })
  }
}

void bootstrap()
