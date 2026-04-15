import * as PIXI from 'pixi.js'
import { Live2DModel, cubism4Ready } from 'pixi-live2d-display/cubism4'

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

type Msg = SyncParam | ActionMsg

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
  const chrome = document.getElementById('figure-chrome')
  if (!canvas || !chrome) return

  window.PIXI = PIXI
  Live2DModel.registerTicker(PIXI.Ticker.shared)

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

  let hoverTarget: PIXI.Container = face
  let liveModel: InstanceType<typeof Live2DModel> | null = null
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
    }
    const fill = palette[expr] ?? 0x6ec5ff
    face.clear()
    face.beginFill(fill, 0.88)
    face.drawCircle(0, 0, FACE_RADIUS)
    face.endFill()
  }

  let hideChromeTimer: ReturnType<typeof setTimeout> | undefined

  const layoutChrome = (): void => {
    const b = hoverTarget.getBounds()
    const cx = b.x + b.width / 2
    const cyTop = b.y
    const cyBottom = b.y + b.height
    chrome.style.transform = 'translate(0, 0)'
    const rect = chrome.getBoundingClientRect()
    const w = rect.width || 160
    const h = rect.height || 56
    let left = cx - w / 2
    let top = cyTop - h - 12
    if (top < 8) top = cyBottom + 10
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8))
    chrome.style.left = `${left}px`
    chrome.style.top = `${top}px`
  }

  const showChrome = (): void => {
    if (hideChromeTimer) {
      clearTimeout(hideChromeTimer)
      hideChromeTimer = undefined
    }
    chrome.classList.add('visible')
    chrome.setAttribute('aria-hidden', 'false')
    layoutChrome()
  }

  const scheduleHideChrome = (): void => {
    if (hideChromeTimer) clearTimeout(hideChromeTimer)
    hideChromeTimer = setTimeout(() => {
      chrome.classList.remove('visible')
      chrome.setAttribute('aria-hidden', 'true')
      hideChromeTimer = undefined
    }, 280)
  }

  chrome.addEventListener('pointerenter', () => {
    if (hideChromeTimer) {
      clearTimeout(hideChromeTimer)
      hideChromeTimer = undefined
    }
  })
  chrome.addEventListener('pointerleave', scheduleHideChrome)

  const modelUrl = window.infinitiLiveUi?.model3FileUrl?.trim() ?? ''

  const wireHover = (target: PIXI.Container): void => {
    if (hoverTarget !== face) {
      hoverTarget.off('pointerover', showChrome)
      hoverTarget.off('pointerout', scheduleHideChrome)
    } else {
      face.off('pointerover', showChrome)
      face.off('pointerout', scheduleHideChrome)
    }
    hoverTarget = target
    hoverTarget.interactive = true
    hoverTarget.cursor = 'pointer'
    hoverTarget.on('pointerover', showChrome)
    hoverTarget.on('pointerout', scheduleHideChrome)
  }

  if (modelUrl) {
    try {
      await cubism4Ready()
      const model = await Live2DModel.from(modelUrl, { autoInteract: false })
      liveModel = model
      app.stage.removeChild(face)
      app.stage.removeChild(mouth)
      liveModel.anchor.set(0.5, 0.5)
      const layoutLive2d = (): void => {
        liveModel!.position.set(app.screen.width / 2, app.screen.height / 2 + 20)
        const uw = liveModel!.width || 400
        const uh = liveModel!.height || 600
        const s = Math.min((app.screen.width * 0.92) / uw, (app.screen.height * 0.85) / uh)
        liveModel!.scale.set(s, s)
      }
      layoutLive2d()
      app.stage.addChild(liveModel)
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
    }
  } else {
    app.stage.addChild(face)
    app.stage.addChild(mouth)
    applyPlaceholderExpression('neutral')
    redrawPlaceholderMouth()
    wireHover(face)
  }

  window.addEventListener('resize', () => {
    app.renderer.resize(window.innerWidth, window.innerHeight)
    face.position.set(app.screen.width / 2, app.screen.height / 2 - 20)
    mouth.position.set(face.x, face.y + 38)
    if (liveModel) {
      liveModel.position.set(app.screen.width / 2, app.screen.height / 2 + 20)
      const uw = liveModel.width || 400
      const uh = liveModel.height || 600
      const s = Math.min((app.screen.width * 0.92) / uw, (app.screen.height * 0.85) / uh)
      liveModel.scale.set(s, s)
    }
    layoutChrome()
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
      if (em) {
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
      const motion = msg.data?.motion
      if (motion && liveModel) {
        console.debug('[liveui] motion 指令（可扩展 motion 组映射）:', motion)
      }
    }
  })

  app.ticker.add(() => {
    if (!liveModel) {
      const t = performance.now() / 1000
      face.scale.set(1 + Math.sin(t * 2.2) * 0.012)
    }
    if (chrome.classList.contains('visible')) {
      layoutChrome()
    }
  })
}

void bootstrap()
