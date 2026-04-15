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

declare global {
  interface Window {
    infinitiLiveUi?: { port: string; model3FileUrl: string }
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

type Msg = SyncParam | ActionMsg | AssistantStreamMsg | StatusPillMsg

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

function setMouthFromModel(model: InstanceType<typeof Live2DModel>, value01: number): void {
  const im = model.internalModel as { coreModel?: { setParameterValueById?: (id: string, v: number) => void } }
  const core = im?.coreModel
  if (!core || typeof core.setParameterValueById !== 'function') return
  try {
    core.setParameterValueById('ParamMouthOpenY', Math.max(0, Math.min(1, value01)))
  } catch {
    /* 部分模型无此参数 */
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
   * 脚底对齐在「字幕气泡顶」（气泡可见时）或「控制条顶」（无气泡时），略陷入则像站在对话框上；
   * 再用控制条上沿做硬顶，避免踩进输入区。参数见 `figureLayoutConfig.ts`。
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

    const bubbleOn = speechBubble?.classList.contains('visible') ?? false
    const platformTop = bubbleOn
      ? (speechBubble!.getBoundingClientRect().top - canvasRect.top)
      : controlBarTop

    const dock = document.getElementById('liveui-bottom-dock')
    const fallbackPlatform =
      dock != null
        ? dock.getBoundingClientRect().top - canvasRect.top
        : Math.max(120, H - Math.ceil(window.innerHeight * FIGURE_LAYOUT.fallbackDockReserveScreenFraction))
    const effectivePlatform =
      controlBar != null ? platformTop : fallbackPlatform

    const stand = FIGURE_LAYOUT.footStandOnOverlapPx
    const targetFootY = effectivePlatform + stand - gap

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

  const stopTypewriter = (): void => {
    if (typewriterRaf !== undefined) {
      cancelAnimationFrame(typewriterRaf)
      typewriterRaf = undefined
    }
  }

  const resetSpeechBubble = (): void => {
    stopTypewriter()
    bubbleTarget = ''
    bubbleShown = 0
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
    if (bubbleShown > bubbleTarget.length) bubbleShown = bubbleTarget.length
    speechBubble.classList.add('visible')
    speechBubble.setAttribute('aria-hidden', 'false')
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
  })

  const dockEl = document.getElementById('liveui-bottom-dock')
  if (dockEl && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(() => layoutFigureInStage())
    })
    ro.observe(dockEl)
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => layoutFigureInStage())
  })

  const port = readPort()
  const wsUrl = `ws://127.0.0.1:${port}`
  const socket = new WebSocket(wsUrl)

  socket.addEventListener('open', () => {
    console.debug('[liveui] WebSocket 已连接', wsUrl)
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
      mouthOpen = Math.max(0, Math.min(1, Number(msg.data.value) || 0))
      if (liveModel) {
        setMouthFromModel(liveModel, mouthOpen)
      } else {
        redrawPlaceholderMouth()
      }
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
    } else if (msg.type === 'STATUS_PILL' && statusPill) {
      const label = typeof msg.data?.label === 'string' ? msg.data.label : '就绪'
      const v = msg.data?.variant
      const variant: LiveUiStatusVariant =
        v === 'ready' || v === 'busy' || v === 'warn' || v === 'loading' ? v : 'ready'
      statusPill.textContent = label
      statusPill.className = `liveui-status-pill liveui-status-pill--${variant}`
    }
  })

  userLineInput?.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || ev.shiftKey) return
    ev.preventDefault()
    const v = userLineInput.value.trimEnd()
    if (!v.trim()) return
    if (socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ type: 'USER_INPUT', data: { line: v } }))
    userLineInput.value = ''
  })

  for (const id of ['liveui-btn-voice', 'liveui-btn-mute', 'liveui-btn-hand'] as const) {
    document.getElementById(id)?.addEventListener('click', () => {
      console.debug(`[liveui] toolbar placeholder: ${id}`)
    })
  }

  app.ticker.add(() => {
    if (!liveModel) {
      const t = performance.now() / 1000
      face.scale.set(1 + Math.sin(t * 2.2) * 0.012)
    }
  })
}

void bootstrap()
