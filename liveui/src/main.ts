import { Application, Circle, Graphics } from 'pixi.js'

declare global {
  interface Window {
    /** Electron preload 注入 */
    infinitiLiveUi?: { port: string; model3FileUrl: string }
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

async function probeModelJson(fileUrl: string): Promise<string | null> {
  try {
    const r = await fetch(fileUrl)
    if (!r.ok) return `HTTP ${r.status}`
    await r.json()
    return null
  } catch (e) {
    return (e as Error).message
  }
}

async function bootstrap(): Promise<void> {
  const canvas = document.getElementById('app') as HTMLCanvasElement | null
  const chrome = document.getElementById('figure-chrome')
  if (!canvas || !chrome) return

  const app = new Application({
    view: canvas,
    backgroundAlpha: 0,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
    width: window.innerWidth,
    height: window.innerHeight,
  })

  const face = new Graphics()
  face.beginFill(0x6ec5ff, 0.85)
  face.drawCircle(0, 0, FACE_RADIUS)
  face.endFill()
  face.position.set(app.screen.width / 2, app.screen.height / 2 - 20)
  face.eventMode = 'static'
  face.cursor = 'pointer'
  face.hitArea = new Circle(0, 0, FACE_RADIUS)
  app.stage.addChild(face)

  const mouth = new Graphics()
  mouth.position.set(face.x, face.y + 38)
  app.stage.addChild(mouth)

  let hideChromeTimer: ReturnType<typeof setTimeout> | undefined

  const layoutChrome = (): void => {
    const r = FACE_RADIUS * face.scale.x
    const cx = face.x
    const cy = face.y
    chrome.style.transform = 'translate(0, 0)'
    const rect = chrome.getBoundingClientRect()
    const w = rect.width || 160
    const h = rect.height || 56
    /* 面板贴在人物头顶略上方，不挡脸中心 */
    let left = cx - w / 2
    let top = cy - r - h - 12
    if (top < 8) top = cy + r + 10
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

  face.on('pointerenter', showChrome)
  face.on('pointerleave', scheduleHideChrome)

  chrome.addEventListener('pointerenter', () => {
    if (hideChromeTimer) {
      clearTimeout(hideChromeTimer)
      hideChromeTimer = undefined
    }
  })
  chrome.addEventListener('pointerleave', scheduleHideChrome)

  const modelUrl = window.infinitiLiveUi?.model3FileUrl?.trim() ?? ''
  if (modelUrl) {
    const pe = await probeModelJson(modelUrl)
    if (pe) {
      console.warn('[liveui] model3 校验失败:', pe)
    }
  }

  let mouthOpen = 0
  let expression = 'neutral'

  const redrawMouth = (): void => {
    mouth.clear()
    const w = 36 + mouthOpen * 48
    const h = 6 + mouthOpen * 22
    mouth.beginFill(0x2a1a1a, 0.95)
    mouth.drawRoundedRect(-w / 2, -h / 2, w, h, Math.min(12, h / 2))
    mouth.endFill()
  }

  const applyExpression = (expr: string): void => {
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
    face.hitArea = new Circle(0, 0, FACE_RADIUS)
  }

  applyExpression('neutral')
  redrawMouth()

  window.addEventListener('resize', () => {
    app.renderer.resize(window.innerWidth, window.innerHeight)
    face.position.set(app.screen.width / 2, app.screen.height / 2 - 20)
    mouth.position.set(face.x, face.y + 38)
    layoutChrome()
  })

  const port = readPort()
  const wsUrl = `ws://127.0.0.1:${port}`
  const socket = new WebSocket(wsUrl)

  socket.addEventListener('open', () => {
    console.debug('[liveui] WebSocket 已连接', wsUrl, modelUrl ? '(model3 已配置)' : '')
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
      redrawMouth()
    } else if (msg.type === 'ACTION') {
      const e = msg.data?.expression
      if (e) applyExpression(e)
      const m = msg.data?.motion
      if (m) {
        console.debug('[liveui] motion:', m, 'expression:', expression)
      }
    }
  })

  app.ticker.add(() => {
    const t = performance.now() / 1000
    face.scale.set(1 + Math.sin(t * 2.2) * 0.012)
    if (chrome.classList.contains('visible')) {
      layoutChrome()
    }
  })
}

void bootstrap()
