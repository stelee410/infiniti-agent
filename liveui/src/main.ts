import * as PIXI from 'pixi.js'
import { Live2DModel, cubism4Ready } from 'pixi-live2d-display/cubism4'
import {
  createStreamLiveUiState,
  processAssistantStreamChunk,
  stripLiveUiKnownEmotionTagsEverywhere,
  type StreamLiveUiState,
} from '../../src/liveui/emotionParse.ts'
import type { LiveUiStatusVariant } from '../../src/liveui/protocol.ts'
import type { LiveUiVoiceMicWire } from '../../src/liveui/voiceMicEnv.ts'
import {
  VOICE_MIC_DEFAULT_SILENCE_END_MS,
  VOICE_MIC_DEFAULT_SPEECH_RMS_THRESHOLD,
  VOICE_MIC_DEFAULT_SUPPRESS_INTERRUPT_DURING_TTS,
} from '../../src/liveui/voiceMicEnv.ts'
import { renderLiveUiBubbleMarkdown } from './bubbleMarkdown.ts'
import { FIGURE_LAYOUT } from './figureLayoutConfig.ts'
import {
  HIT_BODY_RE,
  HIT_HEAD_RE,
  LIVE2D_BODY_POKE_MOTIONS,
  LIVE2D_IDLE,
} from './interactionConfig.ts'
import {
  buildEmotionToSpriteIdFromManifest,
  parseSpriteExpressionManifest,
  type SpriteExpressionManifestV1,
} from '../../src/liveui/spriteExpressionManifestCore.ts'

/** 由 expressions.json 注入，覆盖默认 exp_xx 映射 */
let spriteEmotionToIdOverride: Record<string, string> | null = null
/** 与 sprite 同源 manifest，用于气泡去标签正则 */
let streamManifestForStrip: SpriteExpressionManifestV1 | null = null

declare global {
  interface Window {
    infinitiLiveUi?: {
      port: string
      model3FileUrl: string
      /** 含尾斜杠的 `file:` URL，指向含 `exp_01.png`…的目录（与 CLI `spriteExpressions.dir` 一致） */
      spriteExpressionDirFileUrl?: string
      voiceMic?: Partial<LiveUiVoiceMicWire>
      /** `infiniti-agent live --zoom <n>` 注入：人物显示缩放（0.4 ~ 1.5），1 = 不缩放 */
      figureZoom?: number
      setIgnoreMouseEvents?: (ignore: boolean, opts?: { forward?: boolean }) => void
      /** Electron：首帧后按人物包围盒收紧窗口高度 */
      compactWindowHeight?: (height: number) => void
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
  data: {
    audioBase64: string
    format: string
    sampleRate: number
    sequence: number
    channels?: number
  }
}

type AudioResetMsg = { type: 'AUDIO_RESET' }

type TtsStatusMsg = { type: 'TTS_STATUS'; data: { available: boolean } }
type AsrStatusMsg = { type: 'ASR_STATUS'; data: { available: boolean } }
type AsrResultMsg = { type: 'ASR_RESULT'; data: { text: string } }

type SlashCompletionMsg = {
  type: 'SLASH_COMPLETION'
  data: { open?: boolean; items?: unknown }
}

type Msg =
  | SyncParam
  | ActionMsg
  | AssistantStreamMsg
  | StatusPillMsg
  | AudioChunkMsg
  | AudioResetMsg
  | TtsStatusMsg
  | AsrStatusMsg
  | AsrResultMsg
  | SlashCompletionMsg

const FACE_RADIUS = 110

/** 从 Cubism4 MotionManager.definitions（或 model3 的 motions）收集可随机播放的条目的 group/index。 */
function collectMotionEntriesFromDefinitions(
  defs: Record<string, unknown> | undefined | null,
): { group: string; index: number }[] {
  const out: { group: string; index: number }[] = []
  if (!defs || typeof defs !== 'object') return out
  for (const [group, items] of Object.entries(defs)) {
    if (Array.isArray(items)) {
      for (let i = 0; i < items.length; i++) {
        out.push({ group, index: i })
      }
    } else if (items != null && typeof items === 'object') {
      /* 个别 model3 里某组只有单对象无数组包装 */
      out.push({ group, index: 0 })
    }
  }
  return out
}

function readPort(): string {
  const fromPreload = window.infinitiLiveUi?.port?.trim()
  if (fromPreload) return fromPreload
  return new URLSearchParams(window.location.search).get('port') ?? '8080'
}

/** 将 TUI 情感名映射到 mao_pro 等模型的 expression 名（model3 内 Name 字段） */
function emotionToExpressionId(em: string): string {
  const e = em.toLowerCase().trim()
  if (spriteEmotionToIdOverride?.[e]) return spriteEmotionToIdOverride[e]!
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
  const speechBubbleText = document.getElementById(
    'speech-bubble-text',
  ) as HTMLElement | null
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
  /** PNG 表情精灵（`spriteExpressions.dir`）；与 Live2D 二选一，由预加载环境变量决定 */
  let expressionSprite: PIXI.Sprite | null = null
  /** `file:` 基址，含尾斜杠，用于 `new URL('exp_XX.png', base)` */
  let spriteExpressionDirFileUrl = ''
  let spriteNaturalW = 1024
  let spriteNaturalH = 1024
  /** 模型在 scale=1 时的本地包围尺寸，用于缩放计算（勿用 liveModel.width：会含当前 scale，Resize 时会越算越大） */
  let liveModelNaturalW = 400
  let liveModelNaturalH = 600

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
    const dock = document.getElementById('liveui-bottom-dock')
    const controlBar = document.getElementById('liveui-control-bar')
    const minPlatformTop = Math.round(H * FIGURE_LAYOUT.minPlatformTopScreenFraction)
    const fallbackPlatform =
      dock != null
        ? dock.getBoundingClientRect().top - canvasRect.top
        : Math.max(120, H - Math.ceil(window.innerHeight * FIGURE_LAYOUT.fallbackDockReserveScreenFraction))
    const rawPlatform = controlBar
      ? controlBar.getBoundingClientRect().top - canvasRect.top
      : fallbackPlatform
    const platformTop = Math.max(rawPlatform, minPlatformTop)
    const soleCeiling = platformTop - FIGURE_LAYOUT.footClearOfControlBarPx

    const stand = FIGURE_LAYOUT.footStandOnOverlapPx
    const targetFootY = platformTop + stand - gap

    const footNudgeMax = Math.min(
      FIGURE_LAYOUT.footNudgeMaxPx,
      Math.round(H * FIGURE_LAYOUT.footNudgeScreenFraction),
    )

    /**
     * `infiniti-agent live --zoom <n>` 注入的人物缩放系数。仅作用于 Live2D / 精灵，
     * 不影响控制条/输入框（它们是独立 DOM）。范围 0.4 ~ 1.5，缺省 1。
     */
    const figureZoom = (() => {
      const z = window.infinitiLiveUi?.figureZoom
      if (typeof z !== 'number' || !Number.isFinite(z)) return 1
      return Math.max(0.4, Math.min(1.5, z))
    })()

    if (liveModel) {
      const uw = liveModelNaturalW
      const uh = liveModelNaturalH
      const scaleVerticalBudget = Math.max(
        100,
        Math.round(H * FIGURE_LAYOUT.modelScaleViewportHeightFraction),
      )
      const sBase = Math.min(
        (W * FIGURE_LAYOUT.modelWidthScreenFraction) / uw,
        (scaleVerticalBudget * FIGURE_LAYOUT.modelHeightScaleFraction) / uh,
      )
      const s = sBase * figureZoom
      liveModel.scale.set(s, s)
      liveModel.position.set(W / 2, H / 2)
      const b = liveModel.getBounds()
      liveModel.position.y += targetFootY - b.bottom
      liveModel.position.y += footNudgeMax
      const b2 = liveModel.getBounds()
      if (b2.bottom > soleCeiling) {
        liveModel.position.y -= b2.bottom - soleCeiling
      }
    } else if (expressionSprite) {
      const uw = spriteNaturalW
      const uh = spriteNaturalH
      const scaleVerticalBudget = Math.max(
        100,
        Math.round(H * FIGURE_LAYOUT.modelScaleViewportHeightFraction),
      )
      const sBase = Math.min(
        (W * FIGURE_LAYOUT.modelWidthScreenFraction) / uw,
        (scaleVerticalBudget * FIGURE_LAYOUT.modelHeightScaleFraction) / uh,
      )
      const s = sBase * figureZoom
      expressionSprite.scale.set(s, s)
      expressionSprite.position.set(W / 2, H / 2)
      const b = expressionSprite.getBounds()
      expressionSprite.position.y += targetFootY - b.bottom
      expressionSprite.position.y += footNudgeMax
      const b2 = expressionSprite.getBounds()
      if (b2.bottom > soleCeiling) {
        expressionSprite.position.y -= b2.bottom - soleCeiling
      }
      mouth.position.set(b2.x + b2.width / 2, b2.bottom + 10)
    } else {
      let fy = targetFootY - FACE_RADIUS + footNudgeMax
      if (fy + FACE_RADIUS > soleCeiling) {
        fy = soleCeiling - FACE_RADIUS
      }
      face.position.set(W / 2, fy)
      mouth.position.set(face.x, face.y + 38)
    }
  }

  /**
   * 只做一件事：在「当前 layout」下读人物 getBounds()，若头顶留白明显则把窗口高度减掉一截。
   * 不调 window.resize、不迭代 shrink；精灵/Live2D 各在加载完成后各调度一次（+ 表情换图宽高比大变时）。
   */
  const scheduleCompactWindowHeight = (): void => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const c = window.infinitiLiveUi?.compactWindowHeight
        if (typeof c !== 'function') return
        const fig = expressionSprite ?? liveModel
        if (!fig) return
        layoutFigureInStage()
        const b = fig.getBounds()
        const bar = document.getElementById('liveui-control-bar')
        const dockBottom = bar ? Math.ceil(bar.getBoundingClientRect().bottom) : 0
        const minH = Math.max(360, dockBottom + 8)
        const topGoal = 10
        const shrink = Math.max(0, Math.floor(b.top - topGoal))
        const nextH = Math.max(minH, Math.min(1000, window.innerHeight - shrink))
        if (Math.abs(nextH - window.innerHeight) < 10) return
        try {
          c(nextH)
        } catch {
          /* main 不可用 */
        }
      })
    })
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

  /**
   * 气泡内「展出」速度：约 7 字/秒，接近电影字幕节奏（中文 6~8 字/秒），便于跟读；
   * SSE 落后过多时温和提速，避免一口气甩完导致字幕一闪而过。
   */
  const BUBBLE_READING_CHARS_PER_SEC = 7
  /** 三行字幕滚动速度（px/s），约每秒滚一行（15px × 1.55 ≈ 23px/行）。 */
  const BUBBLE_SCROLL_PX_PER_SEC = 28

  let assistantStreamState: StreamLiveUiState = createStreamLiveUiState()
  let typewriterRaf: number | undefined
  let bubbleTarget = ''
  let bubbleShown = 0
  let twLastPerf = 0
  let twCarry = 0
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

  /**
   * 气泡自动隐藏延迟：与 BUBBLE_READING_CHARS_PER_SEC 展出的总时长对齐，再加几秒余韵；
   * 上限避免极长回复一直占屏（仍可在就绪态手动看历史，此处只控制淡出）。
   */
  const estimateReadTimeMs = (text: string): number => {
    const chars = text.replace(/\s+/g, '').length
    const revealMs = (chars / BUBBLE_READING_CHARS_PER_SEC) * 1000 * 1.35
    const tailMs = 9000
    return Math.max(5000, Math.min(180000, revealMs + tailMs))
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
    twLastPerf = 0
    twCarry = 0
    bubbleIsStreaming = true
    if (speechBubbleText) {
      speechBubbleText.innerHTML = ''
      speechBubbleText.scrollTop = 0
    }
    speechBubble?.classList.remove('visible')
    speechBubble?.setAttribute('aria-hidden', 'true')
  }

  const runBubbleReadingFrame = (): void => {
    if (!speechBubbleText || !speechBubble) {
      typewriterRaf = undefined
      return
    }
    const now = performance.now()
    const dt = twLastPerf ? Math.min(50, Math.max(0, now - twLastPerf)) : 0
    twLastPerf = now

    let needMoreFrames = false
    let typedThisFrame = false

    if (bubbleShown < bubbleTarget.length) {
      const behind = bubbleTarget.length - bubbleShown
      let cps = BUBBLE_READING_CHARS_PER_SEC
      if (behind > 320) cps *= 2.2
      else if (behind > 180) cps *= 1.6
      else if (behind > 90) cps *= 1.25
      twCarry += (dt / 1000) * cps
      const add = Math.floor(twCarry)
      twCarry -= add
      if (add > 0) {
        bubbleShown = Math.min(bubbleShown + add, bubbleTarget.length)
        speechBubbleText.innerHTML = renderLiveUiBubbleMarkdown(
          bubbleTarget.slice(0, bubbleShown),
        )
        typedThisFrame = true
      }
      needMoreFrames = bubbleShown < bubbleTarget.length
    }

    const el = speechBubbleText
    const maxScroll = el.scrollHeight - el.clientHeight
    if (maxScroll > 0) {
      if (typedThisFrame || needMoreFrames) {
        /**
         * typewriter 还在出字时，最新一行必须在可视区底部（电影字幕：新字总在最下方）。
         * 直接 snap 到底，避免「字打出来但被 max-height 裁掉」的死角。
         */
        el.scrollTop = maxScroll
      } else {
        const lag = maxScroll - el.scrollTop
        if (lag > 0.75) {
          /** 已经停笔但 scroll 还没到位时，按字幕节奏平滑补完最后一段。 */
          const catchup = lag > 60 ? lag * 0.04 : 0
          const step = Math.min(lag, BUBBLE_SCROLL_PX_PER_SEC * (dt / 1000) + catchup)
          el.scrollTop += step
          needMoreFrames = maxScroll - el.scrollTop > 0.75
        }
      }
    }

    speechBubble.classList.add('visible')
    speechBubble.setAttribute('aria-hidden', 'false')
    positionBubbleOverFigure()

    if (needMoreFrames) {
      typewriterRaf = requestAnimationFrame(runBubbleReadingFrame)
    } else {
      typewriterRaf = undefined
      twLastPerf = 0
    }
  }

  const ensureTypewriter = (): void => {
    if (typewriterRaf !== undefined) return
    if (!speechBubbleText) return
    twLastPerf = performance.now()
    typewriterRaf = requestAnimationFrame(runBubbleReadingFrame)
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
    speechBubbleText.innerHTML = renderLiveUiBubbleMarkdown(
      bubbleTarget.slice(0, bubbleShown),
    )
    speechBubble.classList.add('visible')
    speechBubble.setAttribute('aria-hidden', 'false')
    positionBubbleOverFigure()
    ensureTypewriter()
  }

  const wireHover = (target: PIXI.Container): void => {
    target.interactive = true
    target.cursor = 'default'
  }

  const rawSpriteUrl = window.infinitiLiveUi?.spriteExpressionDirFileUrl?.trim() ?? ''
  if (rawSpriteUrl) {
    spriteExpressionDirFileUrl = rawSpriteUrl.endsWith('/') ? rawSpriteUrl : `${rawSpriteUrl}/`
  }

  spriteEmotionToIdOverride = null
  streamManifestForStrip = null
  if (spriteExpressionDirFileUrl) {
    try {
      const mr = await fetch(new URL('expressions.json', spriteExpressionDirFileUrl))
      if (mr.ok) {
        const raw = await mr.json()
        const m = parseSpriteExpressionManifest(raw)
        spriteEmotionToIdOverride = buildEmotionToSpriteIdFromManifest(m)
        streamManifestForStrip = m
        console.debug('[liveui] 已加载 expressions.json 表情映射')
      }
    } catch (e) {
      console.debug('[liveui] 无 expressions.json 或解析失败，使用内置 exp 映射', e)
    }
  }

  const spritePngUrl = (expBase: string): string =>
    new URL(`${expBase}.png`, spriteExpressionDirFileUrl).href

  const loadSpritePngTexture = (url: string): Promise<PIXI.Texture> =>
    new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(PIXI.Texture.from(img))
      img.onerror = () => reject(new Error(`load failed: ${url}`))
      img.src = url
    })

  if (spriteExpressionDirFileUrl) {
    try {
      const tex = await loadSpritePngTexture(spritePngUrl(emotionToExpressionId('neutral')))
      const sp = new PIXI.Sprite(tex)
      expressionSprite = sp
      sp.anchor.set(0.5, 0.5)
      spriteNaturalW = Math.max(tex.width, 1)
      spriteNaturalH = Math.max(tex.height, 1)
      app.stage.removeChild(face)
      app.stage.removeChild(mouth)
      app.stage.addChild(sp)
      app.stage.addChild(mouth)
      redrawPlaceholderMouth()
      layoutFigureInStage()
      scheduleCompactWindowHeight()
      wireHover(sp)
      console.debug('[liveui] spriteExpressions PNG 已加载', spriteExpressionDirFileUrl)
    } catch (e) {
      console.warn('[liveui] spriteExpressions 首帧失败，回退 Live2D/占位', e)
      expressionSprite = null
      spriteExpressionDirFileUrl = ''
    }
  }

  const modelUrl = expressionSprite ? '' : (window.infinitiLiveUi?.model3FileUrl?.trim() ?? '')

  if (modelUrl) {
    try {
      await cubism4Ready()
      const model = await Live2DModel.from(modelUrl, { autoInteract: false })
      liveModel = model
      app.stage.removeChild(face)
      app.stage.removeChild(mouth)
      liveModel.anchor.set(0.5, 0.5)
      liveModel.scale.set(1, 1)
      const nb = liveModel.getLocalBounds()
      liveModelNaturalW = Math.max(nb.width, 1)
      liveModelNaturalH = Math.max(nb.height, 1)
      app.stage.addChild(liveModel)
      layoutFigureInStage()
      scheduleCompactWindowHeight()
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
  } else if (!expressionSprite) {
    app.stage.addChild(face)
    app.stage.addChild(mouth)
    applyPlaceholderExpression('neutral')
    redrawPlaceholderMouth()
    wireHover(face)
    layoutFigureInStage()
  }

  const applyLive2dExpression = (em: string): void => {
    expression = em
    if (expressionSprite && spriteExpressionDirFileUrl) {
      const base = emotionToExpressionId(em)
      const url = spritePngUrl(base)
      void loadSpritePngTexture(url)
        .then((tex) => {
          if (!expressionSprite) {
            tex.destroy(true)
            return
          }
          const prev = expressionSprite.texture
          expressionSprite.texture = tex
          const prevAspect = spriteNaturalH > 0 ? spriteNaturalW / spriteNaturalH : 0
          spriteNaturalW = Math.max(tex.width, 1)
          spriteNaturalH = Math.max(tex.height, 1)
          const newAspect = spriteNaturalW / spriteNaturalH
          layoutFigureInStage()
          if (Math.abs(newAspect - prevAspect) > 0.02) {
            scheduleCompactWindowHeight()
          }
          if (prev && prev !== tex) prev.destroy(true)
        })
        .catch((e) => console.warn('[liveui] 表情 PNG 加载失败', base, e))
      return
    }
    if (liveModel) {
      const expId = emotionToExpressionId(em)
      void liveModel.expression(expId).catch(() => {
        void liveModel!.expression(0).catch(() => {})
      })
    } else {
      applyPlaceholderExpression(em)
    }
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

  const SLASH_MENU_MAX_ROWS = 10
  type SlashRow = { id: string; kind: string; label: string; desc: string; insert: string }
  let slashMenuOpenLive = false
  let slashRows: SlashRow[] = []
  let slashSel = 0
  let slashSig = ''
  const slashMenuEl = document.getElementById('liveui-slash-menu')
  const slashHintEl = document.getElementById('liveui-slash-menu-hint')
  const slashListEl = document.getElementById('liveui-slash-menu-list')

  const pushComposerDraft = (): void => {
    if (socket.readyState !== WebSocket.OPEN || !userLineInput) return
    socket.send(JSON.stringify({ type: 'USER_COMPOSER', data: { text: userLineInput.value } }))
  }

  const applySlashInsert = (): void => {
    if (!userLineInput || slashRows.length === 0) return
    const item = slashRows[slashSel]
    if (!item) return
    const ins = item.insert.endsWith(' ') ? item.insert : `${item.insert} `
    userLineInput.value = ins
    pushComposerDraft()
  }

  const renderLiveSlashMenu = (): void => {
    if (!slashMenuEl || !slashListEl) return
    if (!slashMenuOpenLive) {
      slashMenuEl.hidden = true
      slashMenuEl.setAttribute('aria-hidden', 'true')
      return
    }
    slashMenuEl.hidden = false
    slashMenuEl.setAttribute('aria-hidden', 'false')
    const total = slashRows.length
    if (slashHintEl) {
      slashHintEl.textContent =
        total === 0
          ? '无匹配项，继续输入或退格'
          : `↑↓ 选择 · Tab 写入 — 共 ${total} 项`
    }
    const n = slashRows.length
    slashSel = n === 0 ? 0 : Math.max(0, Math.min(slashSel, n - 1))
    let start = 0
    if (total > SLASH_MENU_MAX_ROWS) {
      start = Math.max(
        0,
        Math.min(slashSel - Math.floor(SLASH_MENU_MAX_ROWS / 2), total - SLASH_MENU_MAX_ROWS),
      )
    }
    const visible = slashRows.slice(start, start + SLASH_MENU_MAX_ROWS)
    slashListEl.replaceChildren()
    for (let i = 0; i < visible.length; i++) {
      const item = visible[i]!
      const globalIdx = start + i
      const row = document.createElement('li')
      row.className = `liveui-slash-row${globalIdx === slashSel ? ' liveui-slash-row--active' : ''}`
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(globalIdx === slashSel))
      const kindEl = document.createElement('span')
      kindEl.className = 'liveui-slash-kind'
      kindEl.textContent = item.kind === 'command' ? '[命令]' : '[工具]'
      const labEl = document.createElement('span')
      labEl.className = 'liveui-slash-label'
      labEl.textContent = item.label
      const descEl = document.createElement('span')
      descEl.className = 'liveui-slash-desc'
      descEl.textContent = ` — ${item.desc}`
      row.append(kindEl, labEl, descEl)
      slashListEl.append(row)
    }
  }

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
    } else if (expressionSprite) {
      expressionSprite.cursor = 'pointer'
      expressionSprite.on('pointertap', (e: PIXI.InteractionEvent) => {
        const lp = e.data.getLocalPosition(expressionSprite!)
        const head = lp.y < -spriteNaturalH * 0.12
        applyLive2dExpression(head ? 'blush' : 'angry')
        sendLiveUiInteraction(head ? 'head_pat' : 'body_poke')
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
  type QueuedAudio = { kind: 'encoded'; buf: ArrayBuffer } | { kind: 'decoded'; buffer: AudioBuffer }

  let audioCtx: AudioContext | null = null
  let audioPlaying = false
  const audioQueue: QueuedAudio[] = []
  let audioMouthRaf: number | undefined
  let audioSource: AudioBufferSourceNode | null = null
  let audioAnalyser: AnalyserNode | null = null
  const audioAnalyserData = new Uint8Array(256)
  let ttsActive = false

  /** PCM 流式：按 AudioContext 时间线首尾相接，避免多块 BufferSource 链式播放的缝隙与裂音 */
  let pcmTailTime = 0
  /**
   * 新一轮 TTS 的首块排程前增加短暂 playout lead，给网络/解码留一点余量，减轻 underrun 断续感。
   * AUDIO_RESET 时复位。
   */
  let pcmPlayheadPrimed = false
  const PCM_STREAM_PLAYOUT_LEAD_SEC = 0.1
  let pcmScheduleChain: Promise<void> = Promise.resolve()
  let activePcmSources = 0
  const activePcmSourceNodes: AudioBufferSourceNode[] = []
  let ttsPcmAnalyser: AnalyserNode | null = null

  const ensureAudioCtx = (): AudioContext => {
    if (!audioCtx) {
      audioCtx = new AudioContext()
      console.debug('[liveui] AudioContext 已创建, state:', audioCtx.state)
    }
    return audioCtx
  }

  const ensureTtsPcmAnalyser = (ctx: AudioContext): AnalyserNode => {
    if (!ttsPcmAnalyser || ttsPcmAnalyser.context !== ctx) {
      ttsPcmAnalyser = ctx.createAnalyser()
      ttsPcmAnalyser.fftSize = 512
      ttsPcmAnalyser.connect(ctx.destination)
    }
    return ttsPcmAnalyser
  }

  function base64ToArrayBuffer(b64: string): ArrayBuffer {
    const bin = atob(b64)
    const len = bin.length
    const bytes = new Uint8Array(len)
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i) & 0xff
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  }

  /** MOSS generate-stream：pcm_s16le 交织 → AudioBuffer（不经过 decodeAudioData）。 */
  function pcmS16leToAudioBuffer(
    ctx: AudioContext,
    pcmAb: ArrayBuffer,
    sampleRate: number,
    channels: number,
  ): AudioBuffer {
    const dv = new DataView(pcmAb)
    const frameBytes = 2 * channels
    const frameCount = Math.floor(pcmAb.byteLength / frameBytes)
    const buf = ctx.createBuffer(channels, frameCount, sampleRate)
    let o = 0
    for (let i = 0; i < frameCount; i++) {
      for (let ch = 0; ch < channels; ch++) {
        buf.getChannelData(ch)[i] = dv.getInt16(o, true) / 32768
        o += 2
      }
    }
    return buf
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

  const finishTtsPlaybackIfIdle = (): void => {
    if (activePcmSources > 0) return
    /* 非 PCM 路径仍由单个 audioSource 驱动，勿在此处抢停 */
    if (audioSource) return
    pcmTailTime = 0
    if (audioQueue.length > 0) {
      audioPlaying = false
      playNextInQueue()
      return
    }
    pcmTailTime = 0
    pcmPlayheadPrimed = false
    if (audioMouthRaf) cancelAnimationFrame(audioMouthRaf)
    audioMouthRaf = undefined
    audioAnalyser = null
    mouthOpen = 0
    if (liveModel) setMouthFromModel(liveModel, 0)
    else redrawPlaceholderMouth()
    audioPlaying = false
    ttsActive = false
  }

  const schedulePcmChunk = (decoded: AudioBuffer): void => {
    const ctx = ensureAudioCtx()
    const src = ctx.createBufferSource()
    src.buffer = decoded
    const analyser = ensureTtsPcmAnalyser(ctx)
    src.connect(analyser)
    audioAnalyser = analyser

    pcmScheduleChain = pcmScheduleChain.then(async () => {
      try {
        if (ctx.state === 'suspended') {
          await ctx.resume()
          console.debug('[liveui] AudioContext resumed, state:', ctx.state)
        }
      } catch (e) {
        console.warn('[liveui] AudioContext.resume 失败（可点击页面后再试）:', e)
      }

      const now = ctx.currentTime
      let t0: number
      if (!pcmPlayheadPrimed) {
        t0 = now + PCM_STREAM_PLAYOUT_LEAD_SEC
        pcmPlayheadPrimed = true
      } else {
        t0 = pcmTailTime > 0 ? Math.max(now, pcmTailTime) : now
      }
      pcmTailTime = t0 + decoded.duration
      activePcmSources++
      ttsActive = true
      audioPlaying = true
      if (audioMouthRaf === undefined) {
        audioMouthRaf = requestAnimationFrame(setMouthFromAudio)
      }
      console.debug(
        `[liveui] PCM 已排程 @${t0.toFixed(3)}s, 时长 ${decoded.duration.toFixed(3)}s, sr=${decoded.sampleRate}, ch=${decoded.numberOfChannels}`,
      )

      activePcmSourceNodes.push(src)
      src.onended = () => {
        const i = activePcmSourceNodes.indexOf(src)
        if (i >= 0) activePcmSourceNodes.splice(i, 1)
        activePcmSources = Math.max(0, activePcmSources - 1)
        audioPlaying = activePcmSources > 0
        finishTtsPlaybackIfIdle()
      }
      try {
        src.start(t0)
      } catch (e) {
        console.warn('[liveui] PCM start 失败:', e)
        const j = activePcmSourceNodes.indexOf(src)
        if (j >= 0) activePcmSourceNodes.splice(j, 1)
        activePcmSources = Math.max(0, activePcmSources - 1)
        finishTtsPlaybackIfIdle()
      }
    })
  }

  const playNextInQueue = (): void => {
    if (audioPlaying || audioQueue.length === 0) return
    const item = audioQueue.shift()!
    audioPlaying = true
    ttsActive = true
    const ctx = ensureAudioCtx()

    void (async () => {
      try {
        if (ctx.state === 'suspended') {
          await ctx.resume()
          console.debug('[liveui] AudioContext resumed, state:', ctx.state)
        }
      } catch (e) {
        console.warn('[liveui] AudioContext.resume 失败（可点击页面后再试）:', e)
      }

      try {
        let decoded: AudioBuffer
        if (item.kind === 'decoded') {
          decoded = item.buffer
          console.debug(
            `[liveui] PCM 块播放: ${decoded.duration.toFixed(3)}s, sr=${decoded.sampleRate}, ch=${decoded.numberOfChannels}`,
          )
        } else {
          pcmTailTime = 0
          decoded = await ctx.decodeAudioData(item.buf.slice(0))
          console.debug(`[liveui] 音频解码成功: ${decoded.duration.toFixed(2)}s, sampleRate: ${decoded.sampleRate}`)
        }
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
      } catch (e) {
        console.warn('[liveui] 音频解码/播放失败:', e)
        audioPlaying = false
        ttsActive = false
        playNextInQueue()
      }
    })()
  }

  const enqueueAudioChunk = (data: AudioChunkMsg['data']): void => {
    const ctx = ensureAudioCtx()
    if (data.format === 'pcm_s16le') {
      const ch = typeof data.channels === 'number' ? data.channels : 2
      const pcmAb = base64ToArrayBuffer(data.audioBase64)
      console.debug(`[liveui] 收到 PCM 块: ${pcmAb.byteLength} bytes, ch=${ch}, 队列: ${audioQueue.length}`)
      const decoded = pcmS16leToAudioBuffer(ctx, pcmAb, data.sampleRate, ch)
      schedulePcmChunk(decoded)
    } else {
      const pcmAb = base64ToArrayBuffer(data.audioBase64)
      console.debug(`[liveui] 收到音频块: ${pcmAb.byteLength} bytes (${data.format}), 队列: ${audioQueue.length}`)
      audioQueue.push({ kind: 'encoded', buf: pcmAb })
      playNextInQueue()
    }
  }

  const resetAudioQueue = (): void => {
    audioQueue.length = 0
    pcmTailTime = 0
    pcmPlayheadPrimed = false
    pcmScheduleChain = Promise.resolve()
    for (const s of activePcmSourceNodes) {
      try {
        s.stop()
      } catch {
        /* ignore */
      }
    }
    activePcmSourceNodes.length = 0
    activePcmSources = 0
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
    pushComposerDraft()
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
    } else if (msg.type === 'ASR_STATUS') {
      asrAvailable = !!msg.data?.available
      updateMicBtn()
    } else if (msg.type === 'ASR_RESULT') {
      const text = msg.data?.text
      if (typeof text === 'string' && text.trim()) {
        if (userLineInput && !voiceMode) {
          userLineInput.value = text.trim()
          pushComposerDraft()
        }
        touchConvActivity()
      }
    } else if (msg.type === 'SLASH_COMPLETION') {
      const open = !!msg.data?.open
      const raw = msg.data?.items
      const next: SlashRow[] = []
      if (Array.isArray(raw)) {
        for (const it of raw) {
          if (!it || typeof it !== 'object') continue
          const o = it as Record<string, unknown>
          if (
            typeof o.id === 'string' &&
            typeof o.kind === 'string' &&
            typeof o.label === 'string' &&
            typeof o.desc === 'string' &&
            typeof o.insert === 'string'
          ) {
            next.push({
              id: o.id,
              kind: o.kind,
              label: o.label,
              desc: o.desc,
              insert: o.insert,
            })
          }
        }
      }
      const sig = next.map((r) => r.id).join('\0')
      if (sig !== slashSig) {
        slashSig = sig
        slashSel = 0
      }
      slashMenuOpenLive = open
      slashRows = next
      renderLiveSlashMenu()
    } else if (msg.type === 'AUDIO_CHUNK') {
      if (ttsEnabled && msg.data) enqueueAudioChunk(msg.data)
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
      setBubbleFromDisplayText(stripLiveUiKnownEmotionTagsEverywhere(displayText, streamManifestForStrip))
      touchConvActivity()
    } else if (msg.type === 'STATUS_PILL' && statusPill) {
      const label = typeof msg.data?.label === 'string' ? msg.data.label : '就绪'
      const v = msg.data?.variant
      const variant: LiveUiStatusVariant =
        v === 'ready' || v === 'busy' || v === 'warn' || v === 'loading' ? v : 'ready'
      const wasBusy = statusPillVariant === 'busy' || statusPillVariant === 'loading'
      statusPillVariant = variant
      llmBusy = variant === 'busy' || variant === 'loading'
      if (!llmBusy) interruptSent = false
      statusPill.textContent = label
      statusPill.className = `liveui-status-pill liveui-status-pill--${variant}`
      if (wasBusy && variant === 'ready' && bubbleTarget.trim()) {
        bubbleIsStreaming = false
        scheduleBubbleDismiss()
      }
    }
  })

  userLineInput?.addEventListener('input', () => {
    pushComposerDraft()
    touchConvActivity()
  })

  userLineInput?.addEventListener('keydown', (ev) => {
    if (slashMenuOpenLive && slashRows.length > 0) {
      if (ev.key === 'Tab') {
        ev.preventDefault()
        applySlashInsert()
        return
      }
      if (ev.key === 'ArrowUp') {
        ev.preventDefault()
        slashSel = (slashSel - 1 + slashRows.length) % slashRows.length
        renderLiveSlashMenu()
        return
      }
      if (ev.key === 'ArrowDown') {
        ev.preventDefault()
        slashSel = (slashSel + 1) % slashRows.length
        renderLiveSlashMenu()
        return
      }
    }
    if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing) return
    ev.preventDefault()
    const v = userLineInput.value.trimEnd()
    if (!v.trim()) return
    if (socket.readyState !== WebSocket.OPEN) return
    touchConvActivity()
    socket.send(JSON.stringify({ type: 'USER_INPUT', data: { line: v } }))
    userLineInput.value = ''
    pushComposerDraft()
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
    speakerBtn.disabled = !ttsAvailable
    const on = ttsEnabled && ttsAvailable
    speakerBtn.setAttribute('aria-pressed', String(on))
    speakerBtn.title = !ttsAvailable
      ? '语音回复：未配置 TTS（config.tts：minimax 或 moss_tts_nano）'
      : on
        ? '语音回复：已开启'
        : '语音回复：已关闭'
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

  // ── 麦克风按钮：连续语音对话模式 ──
  const resolveVoiceMicWire = (): LiveUiVoiceMicWire => {
    const vm = window.infinitiLiveUi?.voiceMic
    const speech =
      typeof vm?.speechRmsThreshold === 'number' &&
      Number.isFinite(vm.speechRmsThreshold) &&
      vm.speechRmsThreshold > 0
        ? Math.min(0.35, Math.max(0.001, vm.speechRmsThreshold))
        : VOICE_MIC_DEFAULT_SPEECH_RMS_THRESHOLD
    const silence =
      typeof vm?.silenceEndMs === 'number' && Number.isFinite(vm.silenceEndMs)
        ? Math.min(12000, Math.max(200, Math.round(vm.silenceEndMs)))
        : VOICE_MIC_DEFAULT_SILENCE_END_MS
    const suppress =
      vm?.suppressInterruptDuringTts === false
        ? false
        : VOICE_MIC_DEFAULT_SUPPRESS_INTERRUPT_DURING_TTS
    return { speechRmsThreshold: speech, silenceEndMs: silence, suppressInterruptDuringTts: suppress }
  }
  const voiceMic = resolveVoiceMicWire()
  /** 已进入说话段后略低于 speech 门限，避免字间弱音被当成静音 */
  const vadRmsRelease = Math.max(0.004, Math.min(voiceMic.speechRmsThreshold * 0.48, voiceMic.speechRmsThreshold - 1e-6))

  let asrAvailable = false
  let voiceMode = false
  let micStream: MediaStream | null = null
  let mediaRecorder: MediaRecorder | null = null
  let micChunks: Blob[] = []
  let micAnalyser: AnalyserNode | null = null
  let micAudioCtx: AudioContext | null = null
  let vadRaf: number | undefined
  let isSpeaking = false
  let hasSpoken = false
  let silenceStart = 0
  let llmBusy = false
  let interruptSent = false

  /** 进入「在说话」前需连续满足频谱门控的帧数，抑制突发噪声误触 */
  let vadSpeechLikelyStreak = 0
  const VAD_SPEECH_START_FRAMES = 2

  const micBtn = document.getElementById('liveui-btn-mic') as HTMLButtonElement | null
  const micIconIdle = document.getElementById('liveui-mic-icon-idle')
  const micIconRecording = document.getElementById('liveui-mic-icon-recording')

  const updateMicBtn = (): void => {
    if (!micBtn) return
    micBtn.disabled = !asrAvailable
    micBtn.setAttribute('aria-pressed', String(voiceMode))
    micBtn.title = !asrAvailable
      ? '语音输入：未配置 ASR（需在 config 中配置 whisper 或 sherpa_onnx）'
      : voiceMode
        ? '语音模式开启中…点击关闭'
        : '点击进入语音对话模式'
    if (micIconIdle) micIconIdle.style.display = voiceMode ? 'none' : ''
    if (micIconRecording) micIconRecording.style.display = voiceMode ? '' : 'none'
  }

  /** 须与 AnalyserNode.fftSize 一致，否则 getFloatTimeDomainData 行为未定义 */
  const VAD_FFT_SIZE = 512
  const vadTimeDomain = new Float32Array(VAD_FFT_SIZE)
  const vadFreqBytes = new Uint8Array(VAD_FFT_SIZE / 2)

  /** 人声大致集中频段（Hz），用于相对全带的能量占比 */
  const VAD_SPEECH_FMIN = 300
  const VAD_SPEECH_FMAX = 3400
  /** 频段能量占全带比例下限：过低多为低频轰鸣或高频嘶声 */
  const VAD_MIN_SPEECH_BAND_RATIO = 0.33
  /**
   * 语音带内频谱平坦度上限（几何均值/算术均值）。
   * 接近 1 多为宽带噪声；人声有共振峰，通常更低。
   */
  const VAD_MAX_SPEECH_FLATNESS = 0.62
  /** 安静时语音带能量 EMA；用于简易「相对噪声底」判别 */
  let vadNoiseSpeechBandEma = 1e-10
  const VAD_NOISE_EMA = 0.06
  /** 当前帧语音带功率相对噪声底的最小倍数（线性） */
  const VAD_MIN_SPEECH_TO_NOISE = 2.0

  /**
   * 单帧：时域 RMS + 频谱人声特征（频段占比、平坦度、相对噪声底）。
   * 避免重复拉取 Analyser 数据，保证 RMS 与频谱同一时刻。
   */
  const computeVadFrame = (): { rms: number; spectralOk: boolean } => {
    if (!micAnalyser || !micAudioCtx) return { rms: 0, spectralOk: false }

    micAnalyser.getFloatTimeDomainData(vadTimeDomain)
    let sumSq = 0
    for (let i = 0; i < vadTimeDomain.length; i++) {
      const s = vadTimeDomain[i]!
      sumSq += s * s
    }
    const rms = Math.sqrt(sumSq / vadTimeDomain.length)

    const sr = micAudioCtx.sampleRate
    const n = micAnalyser.frequencyBinCount
    if (vadFreqBytes.length < n) return { rms, spectralOk: false }
    micAnalyser.getByteFrequencyData(vadFreqBytes.subarray(0, n))

    const binFromHz = (hz: number) => Math.floor((hz * VAD_FFT_SIZE) / sr)
    const start = Math.max(1, binFromHz(VAD_SPEECH_FMIN))
    const end = Math.min(n - 1, binFromHz(VAD_SPEECH_FMAX))
    if (end <= start) return { rms, spectralOk: true }

    let totalPow = 0
    for (let i = 1; i < n; i++) {
      const v = vadFreqBytes[i]! / 255
      totalPow += v * v
    }
    if (totalPow < 1e-8) return { rms, spectralOk: false }

    let speechPow = 0
    let logSum = 0
    const bandBins = end - start + 1
    for (let i = start; i <= end; i++) {
      const v = vadFreqBytes[i]! / 255
      const p = v * v + 1e-12
      speechPow += p
      logSum += Math.log(p)
    }
    const amean = speechPow / bandBins
    const gmean = Math.exp(logSum / bandBins)
    const flatness = amean > 0 ? gmean / amean : 1
    if (!Number.isFinite(flatness)) return { rms, spectralOk: false }

    const bandRatio = speechPow / totalPow
    const ratioOk = bandRatio >= VAD_MIN_SPEECH_BAND_RATIO
    const flatOk = flatness <= VAD_MAX_SPEECH_FLATNESS

    if (rms < voiceMic.speechRmsThreshold * 0.55) {
      vadNoiseSpeechBandEma =
        (1 - VAD_NOISE_EMA) * vadNoiseSpeechBandEma + VAD_NOISE_EMA * speechPow
    }
    const snrOk =
      speechPow >= VAD_MIN_SPEECH_TO_NOISE * vadNoiseSpeechBandEma ||
      vadNoiseSpeechBandEma < 1e-6

    return { rms, spectralOk: ratioOk && flatOk && snrOk }
  }

  const sendRecordedAudio = (): void => {
    if (micChunks.length === 0) return
    const blob = new Blob(micChunks, { type: 'audio/webm' })
    micChunks = []
    const reader = new FileReader()
    reader.onloadend = () => {
      const base64 = (reader.result as string).split(',')[1]
      if (base64 && socket.readyState === WebSocket.OPEN) {
        console.debug(`[liveui] 发送录音: ${blob.size} bytes`)
        socket.send(JSON.stringify({ type: 'MIC_AUDIO', data: { audioBase64: base64, format: 'webm' } }))
      }
    }
    reader.readAsDataURL(blob)
  }

  const startSegmentRecording = (): void => {
    if (!micStream || mediaRecorder?.state === 'recording') return
    micChunks = []
    const mr = new MediaRecorder(micStream, { mimeType: 'audio/webm;codecs=opus' })
    mediaRecorder = mr
    mr.ondataavailable = (e) => {
      if (e.data.size > 0) micChunks.push(e.data)
    }
    mr.onstop = () => {
      sendRecordedAudio()
    }
    mr.start()
    console.debug('[liveui] 开始录音片段')
  }

  const stopSegmentRecording = (): void => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop()
      mediaRecorder = null
    }
  }

  const vadLoop = (): void => {
    if (!voiceMode) return
    const { rms, spectralOk } = computeVadFrame()
    const now = Date.now()

    const rmsStart = rms > voiceMic.speechRmsThreshold
    const rmsHold = rms > vadRmsRelease

    const blockInterruptForTtsPlayback =
      voiceMic.suppressInterruptDuringTts && (audioPlaying || ttsActive)
    if (llmBusy && !interruptSent && !blockInterruptForTtsPlayback && rmsStart && spectralOk) {
      interruptSent = true
      console.debug('[liveui] 检测到语音打断，发送 INTERRUPT')
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'INTERRUPT' }))
      }
      resetAudioQueue()
    }

    let voiced = false
    if (isSpeaking) {
      voiced = rmsHold
    } else {
      if (rmsStart && spectralOk) vadSpeechLikelyStreak += 1
      else vadSpeechLikelyStreak = 0
      voiced = vadSpeechLikelyStreak >= VAD_SPEECH_START_FRAMES
    }

    if (voiced) {
      if (!isSpeaking) {
        isSpeaking = true
        hasSpoken = true
        if (!llmBusy) startSegmentRecording()
      }
      silenceStart = 0
    } else {
      if (isSpeaking) {
        if (silenceStart === 0) {
          silenceStart = now
        } else if (now - silenceStart >= voiceMic.silenceEndMs) {
          isSpeaking = false
          vadSpeechLikelyStreak = 0
          if (hasSpoken) {
            hasSpoken = false
            stopSegmentRecording()
          }
        }
      }
    }

    vadRaf = requestAnimationFrame(vadLoop)
  }

  const enterVoiceMode = async (): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1 },
      })
      micStream = stream
      micAudioCtx = new AudioContext()
      const source = micAudioCtx.createMediaStreamSource(stream)
      micAnalyser = micAudioCtx.createAnalyser()
      micAnalyser.fftSize = VAD_FFT_SIZE
      source.connect(micAnalyser)

      voiceMode = true
      isSpeaking = false
      hasSpoken = false
      silenceStart = 0
      interruptSent = false
      vadSpeechLikelyStreak = 0
      vadNoiseSpeechBandEma = 1e-10
      updateMicBtn()
      if (userLineInput) {
        userLineInput.disabled = true
        userLineInput.placeholder = '语音模式开启中…'
      }
      vadRaf = requestAnimationFrame(vadLoop)
    } catch (e) {
      console.warn('[liveui] 麦克风获取失败:', e)
    }
  }

  const exitVoiceMode = (): void => {
    voiceMode = false
    if (vadRaf) { cancelAnimationFrame(vadRaf); vadRaf = undefined }
    stopSegmentRecording()
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop())
      micStream = null
    }
    if (micAudioCtx) {
      void micAudioCtx.close()
      micAudioCtx = null
      micAnalyser = null
    }
    isSpeaking = false
    hasSpoken = false
    updateMicBtn()
    if (userLineInput) {
      userLineInput.disabled = false
      userLineInput.placeholder = ''
    }
  }

  micBtn?.addEventListener('click', () => {
    if (!asrAvailable) return
    if (voiceMode) {
      exitVoiceMode()
    } else {
      void enterVoiceMode()
    }
  })

  updateMicBtn()
  updateSpeakerBtn()

  // ── 手掌按钮：随机动作 ──
  let randomMotionBusy = false
  document.getElementById('liveui-btn-hand')?.addEventListener('click', () => {
    if (!liveModel || randomMotionBusy) return
    randomMotionBusy = true
    const im = liveModel.internalModel as {
      settings?: { motions?: Record<string, unknown> }
      motionManager?: { definitions?: Record<string, unknown> }
    }
    /* motionManager.definitions 与 settings.motions 在 Cubism4 为同一数据源；优先读 manager，并兼容非数组条目 + 配置兜底 */
    let allMotions = collectMotionEntriesFromDefinitions(im?.motionManager?.definitions)
    if (allMotions.length === 0) {
      allMotions = collectMotionEntriesFromDefinitions(im?.settings?.motions ?? null)
    }
    if (allMotions.length === 0) {
      allMotions = [
        ...LIVE2D_IDLE.motionPool.map((m) => ({ group: m.group, index: m.index })),
        ...LIVE2D_BODY_POKE_MOTIONS.map((m) => ({ group: m.group, index: m.index })),
      ]
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
    if (!liveModel && !expressionSprite) {
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
      } else if (expressionSprite) {
        const b = expressionSprite.getBounds()
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
