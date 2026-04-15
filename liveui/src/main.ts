import { Application, Graphics, Text } from 'pixi.js'

type SyncParam = {
  type: 'SYNC_PARAM'
  data: { id: 'ParamMouthOpenY'; value: number }
}

type ActionMsg = {
  type: 'ACTION'
  data: { expression?: string; motion?: string }
}

type Msg = SyncParam | ActionMsg

function readPort(): string {
  const q = new URLSearchParams(window.location.search)
  return q.get('port') ?? '8080'
}

async function bootstrap(): Promise<void> {
  const canvas = document.getElementById('app') as HTMLCanvasElement | null
  if (!canvas) return

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
  face.drawCircle(0, 0, 110)
  face.endFill()
  face.position.set(app.screen.width / 2, app.screen.height / 2 - 20)
  app.stage.addChild(face)

  const mouth = new Graphics()
  mouth.position.set(face.x, face.y + 38)
  app.stage.addChild(mouth)

  const label = new Text('LiveUI · 等待连接…', {
    fill: 0xffffff,
    fontSize: 13,
    dropShadow: true,
    dropShadowBlur: 3,
    dropShadowDistance: 1,
  })
  label.anchor.set(0.5, 0)
  label.position.set(app.screen.width / 2, 12)
  app.stage.addChild(label)

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
    face.drawCircle(0, 0, 110)
    face.endFill()
  }

  applyExpression('neutral')
  redrawMouth()

  window.addEventListener('resize', () => {
    app.renderer.resize(window.innerWidth, window.innerHeight)
    face.position.set(app.screen.width / 2, app.screen.height / 2 - 20)
    mouth.position.set(face.x, face.y + 38)
    label.position.set(app.screen.width / 2, 12)
  })

  const port = readPort()
  const wsUrl = `ws://127.0.0.1:${port}`
  const socket = new WebSocket(wsUrl)

  socket.addEventListener('open', () => {
    label.text = `LiveUI · 已连接 ${wsUrl}`
  })
  socket.addEventListener('close', () => {
    label.text = 'LiveUI · 连接已断开'
  })
  socket.addEventListener('error', () => {
    label.text = 'LiveUI · WebSocket 错误'
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
        label.text = `LiveUI · ${expression} · motion:${m}`
      }
    }
  })

  app.ticker.add(() => {
    // 轻微 idle 动画（与主进程口型叠加）
    const t = performance.now() / 1000
    face.scale.set(1 + Math.sin(t * 2.2) * 0.012)
  })
}

void bootstrap()
