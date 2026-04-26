import { type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { WebSocketServer, WebSocket } from 'ws'
import type {
  LiveUiActionMessage,
  LiveUiAssistantStreamMessage,
  LiveUiAudioChunkMessage,
  LiveUiInboxItem,
  LiveUiMessage,
  LiveUiSlashCompletionItem,
  LiveUiStatusVariant,
  LiveUiFileAttachment,
  LiveUiVisionAttachment,
} from './protocol.js'
import { parseSpeakCommandLine } from './speakCommandLine.js'
import { StreamMouthEstimator } from './streamMouth.js'
import type { TtsEngine } from '../tts/engine.js'
import { markdownToTtsPlainText } from '../tts/markdownToTtsPlainText.js'
import type { AsrEngine } from '../asr/whisperAsr.js'
import { captureVisionSnapshotResult } from './visionCapture.js'
import { Real2dClient } from '../real2d/client.js'
import { renderFalAiAvatar } from '../real2d/falClient.js'
import type { Real2dFalConfig, Real2dParamVector } from '../real2d/protocol.js'

type Real2dBridgeOptions = {
  backend?: 'local' | 'fal'
  sourceImage?: string
  fps?: number
  frameFormat?: 'jpeg' | 'webp' | 'png' | 'raw'
  fal?: Parameters<Real2dClient['startSession']>[0]['fal']
}

const DEFAULT_REAL2D_EMOTIONS: Record<string, Real2dParamVector> = {
  neutral: { smile: 0, eyeOpen: 1, brow: 0, pitch: 0, yaw: 0, roll: 0 },
  happy: { smile: 0.8, eyeOpen: 0.92, brow: 0.2, pitch: 5, yaw: 0, roll: 0 },
  sad: { smile: -0.4, eyeOpen: 0.7, brow: -0.3, pitch: -10, yaw: 0, roll: 0 },
  angry: { smile: -0.2, eyeOpen: 0.86, brow: -0.7, pitch: 0, yaw: 0, roll: 0 },
  thinking: { smile: 0.05, eyeOpen: 0.82, brow: 0.25, pitch: -4, yaw: -5, roll: 0 },
  surprised: { smile: 0.1, eyeOpen: 1.18, brow: 0.8, mouthOpen: 0.35, pitch: 3, yaw: 0, roll: 0 },
  blush: { smile: 0.45, eyeOpen: 0.78, brow: 0.2, pitch: -3, yaw: 0, roll: 0 },
  smirk: { smile: 0.35, eyeOpen: 0.9, brow: 0.1, pitch: 2, yaw: 4, roll: -2 },
  frown: { smile: -0.35, eyeOpen: 0.85, brow: -0.35, pitch: -5, yaw: 0, roll: 0 },
}

export type LiveUiConnectionListener = (connected: boolean) => void
export type LiveUiUserLineListener = (line: string) => void
/** 渲染端输入框草稿（含未发送的 `/` 前缀），用于与 TUI 同步斜杠补全。 */
export type LiveUiUserComposerListener = (text: string) => void
export type LiveUiInterruptListener = () => void
export type LiveUiConfigSaveListener = (config: unknown) => void
export type LiveUiInboxMarkReadListener = (ids: string[]) => void
export type LiveUiInboxSaveAsListener = (sourcePath: string, destinationPath: string, requestId?: string) => void

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
  private userComposerListeners = new Set<LiveUiUserComposerListener>()
  private interruptListeners = new Set<LiveUiInterruptListener>()
  private configSaveListeners = new Set<LiveUiConfigSaveListener>()
  private inboxMarkReadListeners = new Set<LiveUiInboxMarkReadListener>()
  private inboxSaveAsListeners = new Set<LiveUiInboxSaveAsListener>()
  private interactionListeners = new Set<LiveUiInteractionListener>()
  private mouthTimer: ReturnType<typeof setInterval> | undefined
  private electronChild: ChildProcess | null = null
  private ttsEngine: TtsEngine | null = null
  private ttsEnabled = true
  private ttsSequence = 0
  private ttsPending: Promise<void> = Promise.resolve()
  private ttsGeneration = 0
  private asrEngine: AsrEngine | null = null
  private lastVisionCapture: { requestId: string; vision: LiveUiVisionAttachment } | undefined
  private pendingVisionAttachment: LiveUiVisionAttachment | undefined
  private pendingFileAttachments: LiveUiFileAttachment[] = []
  private real2dClient: Real2dClient | null = null
  private real2dBackend: 'local' | 'fal' = 'local'
  private real2dSourceImage: string | undefined
  private real2dFal: Real2dFalConfig | undefined
  private real2dSessionId = `live-${Date.now().toString(36)}`
  private real2dParams: Real2dParamVector = { ...DEFAULT_REAL2D_EMOTIONS.neutral }
  private real2dEmotion = 'neutral'
  private lastReal2dMouthAt = 0
  private lastReal2dMouth = 0

  constructor(port: number) {
    this.port = port
  }

  setTtsEnabled(enabled: boolean): void {
    this.ttsEnabled = enabled
    if (!enabled) this.resetAudio()
    this.broadcastTtsStatus()
  }

  setTtsEngine(engine: TtsEngine | null): void {
    this.ttsEngine = engine
    this.broadcastTtsStatus()
  }

  private broadcastTtsStatus(): void {
    this.broadcast({ type: 'TTS_STATUS', data: { available: this.ttsEngine != null, enabled: this.ttsEnabled } } as LiveUiMessage)
  }

  setAsrEngine(engine: AsrEngine | null): void {
    this.asrEngine = engine
    this.broadcastAsrStatus()
  }

  setReal2dClient(client: Real2dClient | null, opts: Real2dBridgeOptions = {}): void {
    const old = this.real2dClient
    if (old && old !== client) {
      void old.stopSession(this.real2dSessionId).catch(() => {})
    }
    this.real2dClient = client
    this.real2dBackend = opts.backend ?? 'local'
    this.real2dSourceImage = opts.sourceImage
    this.real2dFal = opts.fal
    this.real2dParams = { ...DEFAULT_REAL2D_EMOTIONS.neutral }
    this.real2dEmotion = 'neutral'
    this.lastReal2dMouthAt = 0
    this.lastReal2dMouth = 0
    if (!client) {
      this.broadcast({
        type: 'REAL2D_STATUS',
        data: { ready: false, message: 'real2d disabled' },
      } as LiveUiMessage)
      return
    }
    void this.startReal2d(client, opts)
  }

  setReal2dFalRenderer(opts: Real2dBridgeOptions = {}): void {
    if (this.real2dClient) {
      void this.real2dClient.stopSession(this.real2dSessionId).catch(() => {})
    }
    this.real2dClient = null
    this.real2dBackend = 'fal'
    this.real2dSourceImage = opts.sourceImage
    this.real2dFal = opts.fal
    if (!this.real2dFal) {
      console.warn('[liveui] real2d fal 未配置：请在 LiveUI 配置面板填写 fal API Key / model')
    } else if (!this.real2dFal.apiKey && !process.env[this.real2dFal.keyEnv ?? 'FAL_KEY']) {
      console.warn(`[liveui] real2d fal API Key 缺失：请填写 real2d.fal.apiKey 或环境变量 ${this.real2dFal.keyEnv ?? 'FAL_KEY'}`)
    }
    if (!this.real2dSourceImage && !this.real2dFal?.imageUrl) {
      console.warn('[liveui] real2d fal sourceImage 缺失：请在配置面板选择本地图片，或填写 fal.imageUrl')
    }
    this.broadcast({
      type: 'REAL2D_STATUS',
      data: { ready: !!this.real2dFal, backend: 'fal-ai/ai-avatar', message: this.real2dFal ? undefined : 'fal config missing' },
    } as LiveUiMessage)
  }

  private async startReal2d(client: Real2dClient, opts: Real2dBridgeOptions): Promise<void> {
    try {
      const health = await client.health()
      if (!health.ok && health.ready === false) {
        throw new Error(health.message ?? 'real2d service is not ready')
      }
      const started = await client.startSession({
        sessionId: this.real2dSessionId,
        backend: opts.backend,
        sourceImage: opts.sourceImage,
        fps: opts.fps,
        frameFormat: opts.frameFormat,
        fal: opts.fal,
      })
      this.broadcast({
        type: 'REAL2D_STATUS',
        data: {
          ready: started.ready,
          backend: started.backend ?? health.backend,
          fps: health.fps,
          latencyMs: health.latencyMs,
        },
      } as LiveUiMessage)
      console.error(`[liveui] real2d 服务已连接: ${client.baseUrl}`)
      await this.sendReal2dParams(200)
    } catch (e) {
      console.warn(`[liveui] real2d 服务不可用，保持 fallback 渲染: ${(e as Error).message}`)
      this.broadcast({
        type: 'REAL2D_STATUS',
        data: { ready: false, message: (e as Error).message },
      } as LiveUiMessage)
    }
  }

  private broadcastAsrStatus(): void {
    this.broadcast({ type: 'ASR_STATUS', data: { available: this.asrEngine != null } } as LiveUiMessage)
  }

  setElectronChild(proc: ChildProcess | null): void {
    if (this.electronChild && this.electronChild !== proc && !this.electronChild.killed) {
      this.electronChild.kill('SIGTERM')
    }
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

  consumePendingVisionAttachment(): LiveUiVisionAttachment | undefined {
    const vision = this.pendingVisionAttachment
    this.pendingVisionAttachment = undefined
    return vision
  }

  consumePendingFileAttachments(): LiveUiFileAttachment[] {
    const attachments = this.pendingFileAttachments
    this.pendingFileAttachments = []
    return attachments
  }

  clearVisionAttachment(): void {
    this.pendingVisionAttachment = undefined
    this.lastVisionCapture = undefined
    this.pendingFileAttachments = []
    this.broadcast({ type: 'VISION_ATTACHMENT_CLEAR', data: {} } as LiveUiMessage)
  }

  /** 渲染端输入框内容变化（含空串，用于清空 TUI 草稿状态）。 */
  onUserComposer(fn: LiveUiUserComposerListener): () => void {
    this.userComposerListeners.add(fn)
    return () => {
      this.userComposerListeners.delete(fn)
    }
  }

  private emitUserComposer(text: string): void {
    for (const f of this.userComposerListeners) {
      f(text)
    }
  }

  /** 将当前斜杠补全列表推送到所有已连接的 Live 窗口。 */
  sendSlashCompletion(open: boolean, items: LiveUiSlashCompletionItem[]): void {
    this.broadcast({ type: 'SLASH_COMPLETION', data: { open, items } })
  }

  openConfigPanel(cwd: string, config: unknown): void {
    this.broadcast({ type: 'CONFIG_OPEN', data: { cwd, config } } as LiveUiMessage)
  }

  sendConfigStatus(ok: boolean, message: string): void {
    this.broadcast({ type: 'CONFIG_STATUS', data: { ok, message } } as LiveUiMessage)
  }

  sendInboxUpdate(unread: LiveUiInboxItem[]): void {
    this.broadcast({ type: 'INBOX_UPDATE', data: { unread } } as LiveUiMessage)
  }

  sendInboxSaveResult(ok: boolean, message: string): void {
    this.broadcast({ type: 'INBOX_SAVE_RESULT', data: { ok, message } } as LiveUiMessage)
  }

  onInterrupt(fn: LiveUiInterruptListener): () => void {
    this.interruptListeners.add(fn)
    return () => { this.interruptListeners.delete(fn) }
  }

  private emitInterrupt(): void {
    for (const f of this.interruptListeners) f()
  }

  onConfigSave(fn: LiveUiConfigSaveListener): () => void {
    this.configSaveListeners.add(fn)
    return () => {
      this.configSaveListeners.delete(fn)
    }
  }

  private emitConfigSave(config: unknown): void {
    for (const f of this.configSaveListeners) f(config)
  }

  onInboxMarkRead(fn: LiveUiInboxMarkReadListener): () => void {
    this.inboxMarkReadListeners.add(fn)
    return () => {
      this.inboxMarkReadListeners.delete(fn)
    }
  }

  private emitInboxMarkRead(ids: string[]): void {
    for (const f of this.inboxMarkReadListeners) f(ids)
  }

  onInboxSaveAs(fn: LiveUiInboxSaveAsListener): () => void {
    this.inboxSaveAsListeners.add(fn)
    return () => {
      this.inboxSaveAsListeners.delete(fn)
    }
  }

  private emitInboxSaveAs(sourcePath: string, destinationPath: string, requestId?: string): void {
    for (const f of this.inboxSaveAsListeners) f(sourcePath, destinationPath, requestId)
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
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'TTS_STATUS', data: { available: this.ttsEngine != null, enabled: this.ttsEnabled } }))
        ws.send(JSON.stringify({ type: 'ASR_STATUS', data: { available: this.asrEngine != null } }))
      }
      ws.on('message', (buf) => {
        try {
          const raw = typeof buf === 'string' ? buf : buf.toString('utf8')
          const parsed = JSON.parse(raw) as { type?: unknown; data?: unknown }
          const t = parsed?.type
          if (t === 'USER_INPUT' && parsed.data && typeof parsed.data === 'object') {
            const d = parsed.data as { line?: unknown; attachments?: unknown }
            const line = d.line
            if (typeof line !== 'string' || !line.trim()) return
            const trimmed = line.trimEnd()
            const speakText = parseSpeakCommandLine(trimmed)
            if (speakText !== undefined) {
              if (speakText) {
                this.resetAudio()
                this.enqueueTts(speakText)
              }
              return
            }
            const attachments = parseFileAttachments(d.attachments)
            if (attachments.length) {
              this.pendingFileAttachments = attachments
            }
            this.emitUserLine(trimmed)
            return
          }
          if (t === 'VISION_CAPTURE_REQUEST' && parsed.data && typeof parsed.data === 'object') {
            void this.handleVisionCaptureRequest(ws, parsed.data)
            return
          }
          if (t === 'VISION_CAPTURE_CONFIRM' && parsed.data && typeof parsed.data === 'object') {
            const requestId = (parsed.data as { requestId?: unknown }).requestId
            const localVision = parseVisionAttachment((parsed.data as { vision?: unknown }).vision)
            if (typeof requestId === 'string' && localVision) {
              this.pendingVisionAttachment = localVision
              this.lastVisionCapture = { requestId, vision: localVision }
              console.error(`[liveui] local vision attachment confirmed: ${requestId}`)
            } else if (typeof requestId === 'string' && this.lastVisionCapture?.requestId === requestId) {
              this.pendingVisionAttachment = this.lastVisionCapture.vision
              console.error(`[liveui] vision attachment confirmed: ${requestId}`)
            }
            return
          }
          if (t === 'VISION_CAPTURE_CANCEL' && parsed.data && typeof parsed.data === 'object') {
            const requestId = (parsed.data as { requestId?: unknown }).requestId
            if (typeof requestId === 'string' && this.lastVisionCapture?.requestId === requestId) {
              this.lastVisionCapture = undefined
            }
            return
          }
          if (t === 'VISION_ATTACHMENT_CLEAR') {
            this.pendingVisionAttachment = undefined
            this.pendingFileAttachments = []
            return
          }
          if (t === 'ATTACHMENT_CLEAR') {
            this.pendingFileAttachments = []
            return
          }
          if (t === 'USER_COMPOSER' && parsed.data && typeof parsed.data === 'object') {
            const text = (parsed.data as { text?: unknown }).text
            if (typeof text !== 'string') return
            this.emitUserComposer(text)
            return
          }
          if (t === 'TTS_TOGGLE' && parsed.data && typeof parsed.data === 'object') {
            const enabled = (parsed.data as { enabled?: unknown }).enabled
            this.ttsEnabled = !!enabled
            this.broadcastTtsStatus()
            return
          }
          if (t === 'INTERRUPT') {
            this.resetAudio()
            this.emitInterrupt()
            return
          }
          if (t === 'CONFIG_SAVE' && parsed.data && typeof parsed.data === 'object') {
            this.emitConfigSave((parsed.data as { config?: unknown }).config)
            return
          }
          if (t === 'INBOX_MARK_READ' && parsed.data && typeof parsed.data === 'object') {
            const ids = (parsed.data as { ids?: unknown }).ids
            if (Array.isArray(ids)) {
              const clean = ids
                .filter((x): x is string => typeof x === 'string' && !!x.trim())
                .map((x) => x.trim())
              if (clean.length > 0) this.emitInboxMarkRead(clean)
            }
            return
          }
          if (t === 'INBOX_SAVE_AS' && parsed.data && typeof parsed.data === 'object') {
            const d = parsed.data as { sourcePath?: unknown; destinationPath?: unknown; requestId?: unknown }
            if (typeof d.sourcePath === 'string' && typeof d.destinationPath === 'string') {
              this.emitInboxSaveAs(
                d.sourcePath,
                d.destinationPath,
                typeof d.requestId === 'string' ? d.requestId : undefined,
              )
            }
            return
          }
          if (t === 'MIC_AUDIO' && parsed.data && typeof parsed.data === 'object') {
            const d = parsed.data as { audioBase64?: string; format?: string }
            if (typeof d.audioBase64 === 'string' && this.asrEngine) {
              void this.handleMicAudio(d.audioBase64, d.format ?? 'webm', ws)
            }
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
    this.updateReal2dMouth(v)
  }

  sendAction(data: LiveUiActionMessage['data']): void {
    this.broadcast({ type: 'ACTION', data })
    this.updateReal2dAction(data)
  }

  /** 将模型原始流发给渲染进程（含 [Happy] 等标签），由前端解析表情与气泡正文。 */
  sendAssistantStream(fullRaw: string, reset = false, done = false): void {
    const data: LiveUiAssistantStreamMessage['data'] = { fullRaw, reset, done }
    this.broadcast({ type: 'ASSISTANT_STREAM', data })
  }

  /** 同步底部栏左侧状态胶囊（就绪 / 处理中 / 渲染未连接等）。 */
  sendStatusPill(label: string, variant: LiveUiStatusVariant): void {
    this.broadcast({ type: 'STATUS_PILL', data: { label, variant } })
  }

  /** 通知渲染端清空音频队列（新一轮 assistant 回答开始时调用）。 */
  resetAudio(): void {
    this.ttsGeneration++
    this.ttsSequence = 0
    this.ttsPending = Promise.resolve()
    this.broadcast({ type: 'AUDIO_RESET' })
    this.updateReal2dMouth(0, true)
  }

  /**
   * 异步合成一句话的 TTS 并发送 AUDIO_CHUNK 到渲染端。
   * 串行排队，不阻塞调用方。
   */
  enqueueTts(text: string): void {
    if (!this.ttsEngine || !this.ttsEnabled || !text.trim()) return
    const plain = markdownToTtsPlainText(text)
    if (!plain.trim()) return
    console.error(`[liveui] TTS 请求: ${plain.slice(0, 60)}${plain.length > 60 ? '…' : ''}`)
    const engine = this.ttsEngine
    const generation = this.ttsGeneration
    this.ttsPending = this.ttsPending.then(async () => {
      try {
        if (generation !== this.ttsGeneration) return
        if (engine.synthesizeStream) {
          let chunks = 0
          let bytes = 0
          const audioParts: Buffer[] = []
          let audioFormat: 'mp3' | 'wav' | 'pcm_s16le' | undefined
          let audioSampleRate = 24000
          let audioChannels = 1
          await engine.synthesizeStream(plain, async (out) => {
            if (generation !== this.ttsGeneration) return
            if (out.data.length === 0) return
            chunks += 1
            bytes += out.data.length
            audioParts.push(out.data)
            audioFormat = out.format
            audioSampleRate = out.sampleRate
            audioChannels = out.channels ?? 1
            if (chunks === 1) {
              console.error(
                `[liveui] TTS 首包: ${out.format}, ${out.sampleRate}Hz, ${out.channels ?? 1}ch, ${out.data.length} bytes`,
              )
            }
            const chunkSeq = this.ttsSequence++
            const payload: LiveUiAudioChunkMessage['data'] = {
              audioBase64: out.data.toString('base64'),
              format: out.format,
              sampleRate: out.sampleRate,
              sequence: chunkSeq,
            }
            if (out.format === 'pcm_s16le' && out.channels != null) {
              payload.channels = out.channels
            }
            this.broadcast({ type: 'AUDIO_CHUNK', data: payload })
            this.sendReal2dAudio({
              type: 'AUDIO_CHUNK',
              sessionId: this.real2dSessionId,
              audioBase64: payload.audioBase64,
              format: payload.format,
              sampleRate: payload.sampleRate,
              sequence: payload.sequence,
              channels: payload.channels ?? 1,
            })
          })
          console.error(`[liveui] TTS 完成: ${chunks} chunks, ${bytes} bytes`)
          if (generation === this.ttsGeneration && audioParts.length && audioFormat) {
            this.renderReal2dFalVideo(plain, Buffer.concat(audioParts), audioFormat, audioSampleRate, audioChannels)
          }
          return
        }
        const seq = this.ttsSequence++
        const out = await engine.synthesize(plain)
        if (generation !== this.ttsGeneration) return
        if (out.data.length === 0) return
        console.error(`[liveui] TTS 完成: ${out.format}, ${out.sampleRate}Hz, ${out.data.length} bytes`)
        this.broadcast({
          type: 'AUDIO_CHUNK',
          data: {
            audioBase64: out.data.toString('base64'),
            format: out.format,
            sampleRate: out.sampleRate,
            sequence: seq,
          },
        })
        this.sendReal2dAudio({
          type: 'AUDIO_CHUNK',
          sessionId: this.real2dSessionId,
          audioBase64: out.data.toString('base64'),
          format: out.format,
          sampleRate: out.sampleRate,
          sequence: seq,
          channels: 1,
        })
        this.renderReal2dFalVideo(plain, out.data, out.format, out.sampleRate, 1)
      } catch (e) {
        console.warn(`[liveui] TTS 合成失败: ${(e as Error).message}`)
        if (process.env.INFINITI_AGENT_DEBUG === '1') {
          console.warn((e as Error).stack)
        }
      }
    })
  }

  private async handleVisionCaptureRequest(ws: WebSocket, data: unknown): Promise<void> {
    const requestId =
      data && typeof data === 'object' && typeof (data as { requestId?: unknown }).requestId === 'string'
        ? (data as { requestId: string }).requestId
        : ''
    if (!requestId) return
    const location =
      data && typeof data === 'object'
        ? parseVisionLocation((data as { location?: unknown }).location)
        : undefined

    console.error(`[liveui] vision capture requested: ${requestId}`)
    const result = await captureVisionSnapshotResult({ location })
    if (result.ok) {
      this.lastVisionCapture = { requestId, vision: result.vision }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'VISION_CAPTURE_RESULT',
          data: { requestId, ok: true, vision: result.vision },
        } as LiveUiMessage))
      }
      return
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'VISION_CAPTURE_RESULT',
        data: { requestId, ok: false, error: result.error },
      } as LiveUiMessage))
    }
  }

  private async handleMicAudio(audioBase64: string, format: string, ws: WebSocket): Promise<void> {
    if (!this.asrEngine) return
    try {
      const buf = Buffer.from(audioBase64, 'base64')
      const text = await this.asrEngine.transcribe(buf, format)
      if (!text.trim()) return
      const result = JSON.stringify({ type: 'ASR_RESULT', data: { text: text.trim() } })
      if (ws.readyState === WebSocket.OPEN) ws.send(result)
      this.emitUserLine(text.trim())
    } catch (e) {
      console.warn(`[liveui] ASR 识别失败: ${(e as Error).message}`)
    }
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

  private updateReal2dAction(data: LiveUiActionMessage['data']): void {
    if (data.expression) {
      const em = data.expression.toLowerCase().trim()
      this.real2dEmotion = em
      this.real2dParams = {
        ...this.real2dParams,
        ...(DEFAULT_REAL2D_EMOTIONS[em] ?? DEFAULT_REAL2D_EMOTIONS.neutral),
      }
      void this.sendReal2dParams(200)
    }
    if (data.motion === 'nod') {
      this.real2dParams = { ...this.real2dParams, pitch: 8 }
      void this.sendReal2dParams(180)
      setTimeout(() => {
        this.real2dParams = { ...this.real2dParams, pitch: DEFAULT_REAL2D_EMOTIONS[this.real2dEmotion]?.pitch ?? 0 }
        void this.sendReal2dParams(180)
      }, 220)
    }
  }

  private updateReal2dMouth(value01: number, force = false): void {
    if (!this.real2dClient) return
    const now = Date.now()
    if (!force && now - this.lastReal2dMouthAt < 45 && Math.abs(value01 - this.lastReal2dMouth) < 0.04) return
    this.lastReal2dMouthAt = now
    this.lastReal2dMouth = value01
    this.real2dParams = { ...this.real2dParams, mouthOpen: value01 }
    void this.sendReal2dParams(60)
  }

  private async sendReal2dParams(transitionMs: number): Promise<void> {
    if (!this.real2dClient) return
    try {
      const frame = await this.real2dClient.updateParams({
        type: 'PARAM_UPDATE',
        sessionId: this.real2dSessionId,
        timestampMs: Date.now(),
        emotion: this.real2dEmotion,
        params: this.real2dParams,
        transitionMs,
      })
      if (frame?.type === 'REAL2D_FRAME' && frame.frameBase64) {
        this.broadcast({
          type: 'REAL2D_FRAME',
          data: {
            sessionId: frame.sessionId,
            timestampMs: frame.timestampMs,
            format: frame.format,
            frameBase64: frame.frameBase64,
          },
        } as LiveUiMessage)
      }
    } catch (e) {
      this.broadcast({
        type: 'REAL2D_STATUS',
        data: { ready: false, message: (e as Error).message },
      } as LiveUiMessage)
    }
  }

  private sendReal2dAudio(chunk: Parameters<Real2dClient['sendAudio']>[0]): void {
    if (!this.real2dClient) return
    void this.real2dClient.sendAudio(chunk).catch(() => {})
  }

  private renderReal2dFalVideo(
    text: string,
    audio: Buffer,
    audioFormat: 'mp3' | 'wav' | 'pcm_s16le',
    sampleRate: number,
    channels: number,
  ): void {
    if (this.real2dBackend !== 'fal' || !this.real2dFal) return
    console.error(
      `[liveui] fal ai-avatar 开始: audio=${audio.length} bytes, format=${audioFormat}, source=${this.real2dSourceImage ? 'local-file' : this.real2dFal.imageUrl ? 'image-url' : 'missing'}`,
    )
    const generation = this.ttsGeneration
    this.broadcast({
      type: 'REAL2D_STATUS',
      data: { ready: true, backend: this.real2dFal.model ?? 'fal-ai/ai-avatar', message: 'fal render started' },
    } as LiveUiMessage)
    void renderFalAiAvatar({
      sourceImagePath: this.real2dSourceImage,
      audio,
      audioFormat,
      sampleRate,
      channels,
      text,
      fal: this.real2dFal,
      onLog: (message) => console.error(`[liveui] fal ${message}`),
    }).then((result) => {
      if (generation !== this.ttsGeneration) return
      console.error(`[liveui] fal ai-avatar 完成: request=${result.requestId}`)
      this.broadcast({
        type: 'REAL2D_VIDEO',
        data: { sessionId: this.real2dSessionId, url: result.videoUrl, requestId: result.requestId },
      } as LiveUiMessage)
      this.broadcast({
        type: 'REAL2D_STATUS',
        data: { ready: true, backend: this.real2dFal?.model ?? 'fal-ai/ai-avatar', message: 'fal render complete' },
      } as LiveUiMessage)
    }).catch((e) => {
      console.warn(`[liveui] fal ai-avatar 失败: ${(e as Error).message}`)
      this.broadcast({
        type: 'REAL2D_STATUS',
        data: { ready: false, backend: this.real2dFal?.model ?? 'fal-ai/ai-avatar', message: (e as Error).message },
      } as LiveUiMessage)
    })
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
    if (this.real2dClient) {
      await this.real2dClient.stopSession(this.real2dSessionId).catch(() => {})
      this.real2dClient = null
    }
  }
}

function parseVisionLocation(raw: unknown): LiveUiVisionAttachment['location'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const loc = raw as { latitude?: unknown; longitude?: unknown; accuracy?: unknown }
  if (
    typeof loc.latitude !== 'number' ||
    !Number.isFinite(loc.latitude) ||
    typeof loc.longitude !== 'number' ||
    !Number.isFinite(loc.longitude)
  ) {
    return undefined
  }
  const out: NonNullable<LiveUiVisionAttachment['location']> = {
    latitude: loc.latitude,
    longitude: loc.longitude,
  }
  if (typeof loc.accuracy === 'number' && Number.isFinite(loc.accuracy)) {
    out.accuracy = loc.accuracy
  }
  return out
}

function parseVisionAttachment(raw: unknown): LiveUiVisionAttachment | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const v = raw as {
    imageBase64?: unknown
    mediaType?: unknown
    capturedAt?: unknown
    location?: unknown
  }
  if (
    typeof v.imageBase64 !== 'string' ||
    typeof v.capturedAt !== 'string' ||
    (v.mediaType !== 'image/jpeg' && v.mediaType !== 'image/png' && v.mediaType !== 'image/webp')
  ) {
    return undefined
  }
  return {
    imageBase64: v.imageBase64,
    mediaType: v.mediaType,
    capturedAt: v.capturedAt,
    ...(parseVisionLocation(v.location) ? { location: parseVisionLocation(v.location) } : {}),
  }
}

const MAX_ATTACHMENTS = 12
const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024
const ALLOWED_ATTACHMENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/markdown',
  'text/csv',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])

function parseFileAttachments(raw: unknown): LiveUiFileAttachment[] {
  if (!Array.isArray(raw)) return []
  const out: LiveUiFileAttachment[] = []
  let imageCount = 0
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const a = item as {
      id?: unknown
      name?: unknown
      mediaType?: unknown
      base64?: unknown
      size?: unknown
      kind?: unknown
      capturedAt?: unknown
      text?: unknown
    }
    if (
      typeof a.id !== 'string' ||
      typeof a.name !== 'string' ||
      typeof a.mediaType !== 'string' ||
      typeof a.base64 !== 'string' ||
      typeof a.size !== 'number' ||
      !Number.isFinite(a.size) ||
      typeof a.capturedAt !== 'string'
    ) {
      continue
    }
    const kind = a.kind === 'image' ? 'image' : a.kind === 'document' ? 'document' : undefined
    if (!kind || !ALLOWED_ATTACHMENT_TYPES.has(a.mediaType) || a.size > MAX_ATTACHMENT_BYTES) continue
    if (kind === 'image') {
      imageCount++
      if (imageCount > 9) continue
    }
    out.push({
      id: a.id,
      name: a.name,
      mediaType: a.mediaType,
      base64: a.base64,
      size: a.size,
      kind,
      capturedAt: a.capturedAt,
      ...(typeof a.text === 'string' && a.text.trim() ? { text: a.text.slice(0, 80_000) } : {}),
    })
    if (out.length >= MAX_ATTACHMENTS) break
  }
  return out
}
