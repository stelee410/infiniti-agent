import { once } from 'node:events'
import { WebSocketServer, WebSocket } from 'ws'
import type { Real2dClientMessage, Real2dServerMessage, Real2dStatePayload } from './protocol.js'
import type { Real2dPhoneme } from './phonemeState.js'
import { PhonemeStateMachine } from './phonemeState.js'
import { createIdleness } from './idleness.js'
import { buildFaceMeshGrid, applyParallaxOffsets } from './meshGrid.js'

export type Real2dWsBridgeOptions = {
  port: number
  /** 默认 Luna 第一张表情 */
  faceTexture?: string
  /** 广播状态频率（默认 30） */
  tickHz?: number
}

/**
 * 本地 WebSocket 桥：合并音素状态机、idle 呼吸、Parallax 网格采样（每帧取鼻点位移代表值）。
 * 供后续 Electron+Pixi 对接；CLI `real2d ws` 用于联调。
 */
export class Real2dWsBridge {
  readonly port: number
  private wss: WebSocketServer | null = null
  private clients = new Set<WebSocket>()
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly phoneme = new PhonemeStateMachine()
  private readonly idle = createIdleness()
  private rotationX = 0
  private emotionIntensity = 0
  private vibeFrequency = 0.12
  private faceTexture: string
  private t0 = Date.now()
  private mesh = buildFaceMeshGrid()
  private tickHz: number

  constructor(opts: Real2dWsBridgeOptions) {
    this.port = opts.port
    this.faceTexture = opts.faceTexture ?? 'exp_01.png'
    this.tickHz = Math.min(60, Math.max(10, opts.tickHz ?? 30))
  }

  async start(): Promise<void> {
    if (this.wss) return
    const wss = new WebSocketServer({ port: this.port })
    this.wss = wss
    await once(wss, 'listening')

    wss.on('connection', (ws) => {
      this.clients.add(ws)
      this.send(ws, { type: 'real2d_hello', version: 1 })
      ws.on('message', (buf) => this.onClientMessage(ws, buf))
      ws.on('close', () => {
        this.clients.delete(ws)
      })
    })

    const dt = 1000 / this.tickHz
    this.timer = setInterval(() => this.tick(dt), dt)
  }

  private onClientMessage(ws: WebSocket, buf: WebSocket.RawData): void {
    let msg: unknown
    try {
      msg = JSON.parse(String(buf))
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return
    const m = msg as Real2dClientMessage
    if (m.type === 'real2d_ping') {
      this.send(ws, { type: 'real2d_pong', nonce: m.nonce })
      return
    }
    if (m.type === 'real2d_drive') {
      this.rotationX = m.rotationX
      this.phoneme.setPhoneme(m.phoneme)
      if (typeof m.emotionIntensity === 'number') {
        this.emotionIntensity = Math.min(1, Math.max(0, m.emotionIntensity))
      }
      if (typeof m.vibeFrequency === 'number' && Number.isFinite(m.vibeFrequency)) {
        this.vibeFrequency = m.vibeFrequency
      }
    }
  }

  private tick(dt: number): void {
    this.phoneme.tick(dt)
    const id = this.idle.tick(dt)
    const drive = this.phoneme.getDrive()
    const displaced = applyParallaxOffsets(this.mesh.vertices, this.rotationX, 0.08)
    const idx = 6 * 15 + 7
    const base = this.mesh.vertices[idx] ?? this.mesh.vertices[0]!
    const nose = displaced[idx] ?? displaced[0]!
    const parallaxSampleDx = nose.x - base.x

    const data: Real2dStatePayload = {
      rotationX: this.rotationX,
      phoneme: drive.phoneme,
      jawOpen: drive.jawOpen,
      mouthLayerB: drive.mouthLayerB,
      breathY: id.breathY,
      gazeX: id.gazeX,
      gazeY: id.gazeY,
      emotionIntensity: this.emotionIntensity,
      vibeFrequency: this.vibeFrequency,
      faceTexture: this.faceTexture,
      parallaxSampleDx,
      tMillis: Date.now() - this.t0,
    }
    this.broadcast({ type: 'real2d_state', data })
  }

  setFaceTexture(fileName: string): void {
    this.faceTexture = fileName
  }

  /** 测试或主进程直接注入 */
  injectDrive(partial: { rotationX?: number; phoneme?: Real2dPhoneme; emotionIntensity?: number }): void {
    if (typeof partial.rotationX === 'number') this.rotationX = partial.rotationX
    if (partial.phoneme) this.phoneme.setPhoneme(partial.phoneme)
    if (typeof partial.emotionIntensity === 'number') {
      this.emotionIntensity = Math.min(1, Math.max(0, partial.emotionIntensity))
    }
  }

  private send(ws: WebSocket, msg: Real2dServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  private broadcast(msg: Real2dServerMessage): void {
    const s = JSON.stringify(msg)
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(s)
    }
  }

  async dispose(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    if (this.wss) {
      await new Promise<void>((resolve) => {
        for (const ws of this.clients) {
          try {
            ws.terminate()
          } catch {
            /* ignore */
          }
        }
        this.clients.clear()
        this.wss!.close(() => resolve())
        this.wss = null
      })
    }
  }
}
