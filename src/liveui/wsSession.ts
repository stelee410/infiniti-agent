import { type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { WebSocketServer, WebSocket } from 'ws'
import type { LiveUiActionMessage, LiveUiMessage } from './protocol.js'
import { StreamMouthEstimator } from './streamMouth.js'

export type LiveUiConnectionListener = (connected: boolean) => void

export class LiveUiSession {
  readonly port: number
  readonly mouth = new StreamMouthEstimator()

  private wss: WebSocketServer | null = null
  private clients = new Set<WebSocket>()
  private listeners = new Set<LiveUiConnectionListener>()
  private mouthTimer: ReturnType<typeof setInterval> | undefined
  private electronChild: ChildProcess | null = null

  constructor(port: number) {
    this.port = port
  }

  setElectronChild(proc: ChildProcess | null): void {
    this.electronChild = proc
  }

  get clientConnected(): boolean {
    return this.clients.size > 0
  }

  onConnectionChange(fn: LiveUiConnectionListener): () => void {
    this.listeners.add(fn)
    fn(this.clientConnected)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private emitConn(): void {
    const ok = this.clientConnected
    for (const f of this.listeners) f(ok)
  }

  async start(): Promise<void> {
    if (this.wss) return
    const wss = new WebSocketServer({ port: this.port })
    this.wss = wss
    await once(wss, 'listening')

    wss.on('connection', (ws) => {
      this.clients.add(ws)
      this.emitConn()
      ws.on('close', () => {
        this.clients.delete(ws)
        this.emitConn()
      })
      ws.on('error', () => {
        this.clients.delete(ws)
        this.emitConn()
      })
    })

    wss.on('error', (err) => {
      console.error(`[liveui] WebSocket 服务错误: ${(err as Error).message}`)
    })
  }

  broadcast(msg: LiveUiMessage): void {
    const s = JSON.stringify(msg)
    for (const c of this.clients) {
      if (c.readyState === WebSocket.OPEN) {
        c.send(s)
      }
    }
  }

  sendMouth(value01: number): void {
    const v = Math.max(0, Math.min(1, value01))
    this.broadcast({ type: 'SYNC_PARAM', data: { id: 'ParamMouthOpenY', value: v } })
  }

  sendAction(data: LiveUiActionMessage['data']): void {
    this.broadcast({ type: 'ACTION', data })
  }

  startMouthPump(): void {
    this.stopMouthPump()
    this.mouthTimer = setInterval(() => {
      this.mouth.tickIdle()
      this.sendMouth(this.mouth.mouthOpen01)
    }, Math.round(1000 / 30))
  }

  stopMouthPump(): void {
    if (this.mouthTimer) {
      clearInterval(this.mouthTimer)
      this.mouthTimer = undefined
    }
  }

  async dispose(): Promise<void> {
    this.stopMouthPump()
    for (const c of this.clients) {
      try {
        c.close()
      } catch {
        /* ignore */
      }
    }
    this.clients.clear()
    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve())
      })
      this.wss = null
    }
    if (this.electronChild && !this.electronChild.killed) {
      this.electronChild.kill('SIGTERM')
      this.electronChild = null
    }
  }
}
