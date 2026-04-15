import { type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync } from 'node:fs'
import { WebSocketServer, WebSocket } from 'ws'
import type {
  LiveUiActionMessage,
  LiveUiAssistantStreamMessage,
  LiveUiMessage,
  LiveUiStatusVariant,
} from './protocol.js'
import { StreamMouthEstimator } from './streamMouth.js'
import type { TtsEngine } from '../tts/minimaxTts.js'

export type LiveUiConnectionListener = (connected: boolean) => void
export type LiveUiUserLineListener = (line: string) => void

/** 渲染端点击 Live2D 头部 / 身体等，由 Node 转成一条合成用户消息请求模型回应 */
export type LiveUiInteractionKind = 'head_pat' | 'body_poke'
export type LiveUiInteractionListener = (kind: LiveUiInteractionKind) => void

export class LiveUiSession {
  readonly port: number
  readonly mouth = new StreamMouthEstimator()

  private wss: WebSocketServer | null = null
  private clients = new Set<WebSocket>()
  private listeners = new Set<LiveUiConnectionListener>()
  private userLineListeners = new Set<LiveUiUserLineListener>()
  private interactionListeners = new Set<LiveUiInteractionListener>()
  private mouthTimer: ReturnType<typeof setInterval> | undefined
  private electronChild: ChildProcess | null = null
  private ttsEngine: TtsEngine | null = null
  private ttsEnabled = true
  private ttsSequence = 0
  private ttsPending: Promise<void> = Promise.resolve()

  constructor(port: number) {
    this.port = port
  }

  setTtsEngine(engine: TtsEngine | null): void {
    this.ttsEngine = engine
    appendFileSync('/tmp/infiniti-tts.log', `[${new Date().toISOString()}] setTtsEngine: engine=${engine != null}, hasTts=${this.hasTts}\n`)
    this.broadcastTtsStatus()
  }

  private broadcastTtsStatus(): void {
    this.broadcast({ type: 'TTS_STATUS', data: { available: this.ttsEngine != null } } as LiveUiMessage)
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

  /** 渲染端通过 WebSocket 发送的用户输入（一行）。 */
  onUserLine(fn: LiveUiUserLineListener): () => void {
    this.userLineListeners.add(fn)
    return () => {
      this.userLineListeners.delete(fn)
    }
  }

  private emitUserLine(line: string): void {
    for (const f of this.userLineListeners) {
      f(line)
    }
  }

  onInteraction(fn: LiveUiInteractionListener): () => void {
    this.interactionListeners.add(fn)
    return () => {
      this.interactionListeners.delete(fn)
    }
  }

  private emitInteraction(kind: LiveUiInteractionKind): void {
    for (const f of this.interactionListeners) {
      f(kind)
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
      if (this.ttsEngine) {
        const status = JSON.stringify({ type: 'TTS_STATUS', data: { available: true } })
        if (ws.readyState === WebSocket.OPEN) ws.send(status)
      }
      ws.on('message', (buf) => {
        try {
          const raw = typeof buf === 'string' ? buf : buf.toString('utf8')
          const parsed = JSON.parse(raw) as { type?: unknown; data?: unknown }
          const t = parsed?.type
          if (t === 'USER_INPUT' && parsed.data && typeof parsed.data === 'object') {
            const line = (parsed.data as { line?: unknown }).line
            if (typeof line !== 'string' || !line.trim()) return
            this.emitUserLine(line.trimEnd())
            return
          }
          if (t === 'TTS_TOGGLE' && parsed.data && typeof parsed.data === 'object') {
            const enabled = (parsed.data as { enabled?: unknown }).enabled
            this.ttsEnabled = !!enabled
            return
          }
          if (t === 'LIVEUI_INTERACTION' && parsed.data && typeof parsed.data === 'object') {
            const kind = (parsed.data as { kind?: unknown }).kind
            if (kind === 'head_pat' || kind === 'body_poke') {
              this.emitInteraction(kind)
            }
          }
        } catch {
          /* ignore invalid client frames */
        }
      })
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

  /** 将模型原始流发给渲染进程（含 [Happy] 等标签），由前端解析表情与气泡正文。 */
  sendAssistantStream(fullRaw: string, reset = false): void {
    const data: LiveUiAssistantStreamMessage['data'] = { fullRaw, reset }
    this.broadcast({ type: 'ASSISTANT_STREAM', data })
  }

  /** 同步底部栏左侧状态胶囊（就绪 / 处理中 / 渲染未连接等）。 */
  sendStatusPill(label: string, variant: LiveUiStatusVariant): void {
    this.broadcast({ type: 'STATUS_PILL', data: { label, variant } })
  }

  /** 通知渲染端清空音频队列（新一轮 assistant 回答开始时调用）。 */
  resetAudio(): void {
    this.ttsSequence = 0
    this.ttsPending = Promise.resolve()
    this.broadcast({ type: 'AUDIO_RESET' })
  }

  /**
   * 异步合成一句话的 TTS 并发送 AUDIO_CHUNK 到渲染端。
   * 串行排队，不阻塞调用方。
   */
  enqueueTts(text: string): void {
    appendFileSync('/tmp/infiniti-tts.log', `[${new Date().toISOString()}] enqueueTts called: engine=${this.ttsEngine != null}, enabled=${this.ttsEnabled}, text="${text.slice(0, 40)}"\n`)
    if (!this.ttsEngine || !this.ttsEnabled || !text.trim()) return
    const seq = this.ttsSequence++
    const engine = this.ttsEngine
    appendFileSync('/tmp/infiniti-tts.log', `[${new Date().toISOString()}] TTS 排队 #${seq}: "${text.slice(0, 40)}"\n`)
    this.ttsPending = this.ttsPending.then(async () => {
      try {
        const buf = await engine.synthesize(text)
        appendFileSync('/tmp/infiniti-tts.log', `[${new Date().toISOString()}] TTS #${seq}: 合成完成 ${buf.length} bytes\n`)
        if (buf.length === 0) return
        appendFileSync('/tmp/infiniti-tts.log', `[${new Date().toISOString()}] TTS #${seq}: 广播到 ${this.clients.size} 个客户端\n`)
        this.broadcast({
          type: 'AUDIO_CHUNK',
          data: {
            audioBase64: buf.toString('base64'),
            format: 'mp3',
            sampleRate: 32000,
            sequence: seq,
          },
        })
      } catch (e) {
        appendFileSync('/tmp/infiniti-tts.log', `[${new Date().toISOString()}] TTS #${seq}: 合成失败: ${(e as Error).message}\n`)
      }
    })
  }

  get hasTts(): boolean {
    return this.ttsEngine != null && this.ttsEnabled
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
