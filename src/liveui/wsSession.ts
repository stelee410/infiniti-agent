import { type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createReadStream, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import type {
  LiveUiActionMessage,
  LiveUiDebugStateMessage,
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
import { parseLiveUiClientMessage, type LiveUiClientMessage } from './clientMessages.js'

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

export function isAllowedLiveUiMediaPath(filePath: string, roots: string[]): boolean {
  const target = resolve(filePath)
  return roots.some((root) => {
    const rel = relative(resolve(root), target)
    return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
  })
}

export class LiveUiSession {
  readonly port: number
  readonly mouth = new StreamMouthEstimator()

  private wss: WebSocketServer | null = null
  private httpServer: Server | null = null
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
  private lastStatusPill: { label: string; variant: LiveUiStatusVariant } = { label: '就绪', variant: 'ready' }

  private readonly mediaRoots: string[]

  constructor(port: number, opts: { mediaRoots?: string[] } = {}) {
    this.port = port
    this.mediaRoots = (opts.mediaRoots ?? []).map((p) => resolve(p))
  }

  setTtsEnabled(enabled: boolean): void {
    this.ttsEnabled = enabled
    if (!enabled) {
      this.resetAudio()
      this.mouth.reset()
      this.sendMouth(0)
    }
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
    this.broadcast({ type: 'ATTACHMENT_CLEAR', data: {} } as LiveUiMessage)
  }

  clearFileAttachments(): void {
    this.pendingFileAttachments = []
    this.broadcast({ type: 'ATTACHMENT_CLEAR', data: {} } as LiveUiMessage)
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

  openInbox(items: LiveUiInboxItem[]): void {
    this.broadcast({ type: 'INBOX_OPEN', data: { items } } as LiveUiMessage)
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
    const httpServer = createServer((req, res) => {
      this.handleHttpRequest(req, res)
    })
    const wss = new WebSocketServer({ server: httpServer })
    this.httpServer = httpServer
    this.wss = wss
    httpServer.listen(this.port)
    await once(httpServer, 'listening')

    wss.on('connection', (ws) => {
      this.clients.add(ws)
      this.emitConn()
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'TTS_STATUS', data: { available: this.ttsEngine != null, enabled: this.ttsEnabled } }))
        ws.send(JSON.stringify({ type: 'ASR_STATUS', data: { available: this.asrEngine != null } }))
        ws.send(JSON.stringify({ type: 'STATUS_PILL', data: this.lastStatusPill }))
      }
      ws.on('message', (buf) => {
        try {
          const raw = typeof buf === 'string' ? buf : buf.toString('utf8')
          const message = parseLiveUiClientMessage(raw)
          if (message) this.handleClientMessage(ws, message)
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

  private handleClientMessage(ws: WebSocket, message: LiveUiClientMessage): void {
    switch (message.type) {
      case 'USER_INPUT': {
        const speakText = parseSpeakCommandLine(message.line)
        if (speakText !== undefined) {
          if (speakText) {
            this.resetAudio()
            this.enqueueTts(speakText)
          }
          return
        }
        if (message.attachments.length) {
          this.pendingFileAttachments = message.attachments
        }
        this.emitUserLine(message.line)
        return
      }
      case 'VISION_CAPTURE_REQUEST':
        void this.handleVisionCaptureRequest(ws, message)
        return
      case 'VISION_CAPTURE_CONFIRM':
        if (message.vision) {
          this.pendingVisionAttachment = message.vision
          this.lastVisionCapture = { requestId: message.requestId, vision: message.vision }
          console.error(`[liveui] local vision attachment confirmed: ${message.requestId}`)
        } else if (this.lastVisionCapture?.requestId === message.requestId) {
          this.pendingVisionAttachment = this.lastVisionCapture.vision
          console.error(`[liveui] vision attachment confirmed: ${message.requestId}`)
        }
        return
      case 'VISION_CAPTURE_CANCEL':
        if (this.lastVisionCapture?.requestId === message.requestId) {
          this.lastVisionCapture = undefined
        }
        return
      case 'VISION_ATTACHMENT_CLEAR':
        this.pendingVisionAttachment = undefined
        this.pendingFileAttachments = []
        return
      case 'ATTACHMENT_CLEAR':
        this.pendingFileAttachments = []
        return
      case 'USER_COMPOSER':
        this.emitUserComposer(message.text)
        return
      case 'TTS_TOGGLE':
        this.setTtsEnabled(message.enabled)
        return
      case 'INTERRUPT':
        this.resetAudio()
        this.emitInterrupt()
        return
      case 'CONFIG_SAVE':
        this.emitConfigSave(message.config)
        return
      case 'INBOX_MARK_READ':
        this.emitInboxMarkRead(message.ids)
        return
      case 'INBOX_SAVE_AS':
        this.emitInboxSaveAs(message.sourcePath, message.destinationPath, message.requestId)
        return
      case 'MIC_AUDIO':
        if (this.asrEngine) {
          void this.handleMicAudio(message.audioBase64, message.format, ws)
        }
        return
      case 'LIVEUI_INTERACTION':
        this.emitInteraction(message.kind)
        return
    }
  }

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' })
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)
    if (url.pathname !== '/media') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
      return
    }
    const filePath = url.searchParams.get('path') ?? ''
    if (!filePath || !isAbsolute(filePath)) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('invalid media path')
      return
    }
    if (!isAllowedLiveUiMediaPath(filePath, this.mediaRoots)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('media path forbidden')
      return
    }

    let st: ReturnType<typeof statSync>
    try {
      st = statSync(filePath)
      if (!st.isFile()) throw new Error('not file')
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('media not found')
      return
    }

    const size = st.size
    const mime = mediaMimeType(filePath)
    const commonHeaders = {
      'Accept-Ranges': 'bytes',
      'Content-Type': mime,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    }
    const range = req.headers.range
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range)
      if (!m) {
        res.writeHead(416, { ...commonHeaders, 'Content-Range': `bytes */${size}` })
        res.end()
        return
      }
      const rawStart = m[1] ? Number(m[1]) : 0
      const rawEnd = m[2] ? Number(m[2]) : size - 1
      const start = Math.max(0, Math.min(rawStart, size - 1))
      const end = Math.max(start, Math.min(rawEnd, size - 1))
      res.writeHead(206, {
        ...commonHeaders,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(end - start + 1),
      })
      if (method === 'HEAD') {
        res.end()
        return
      }
      createReadStream(filePath, { start, end }).pipe(res)
      return
    }

    res.writeHead(200, {
      ...commonHeaders,
      'Content-Length': String(size),
    })
    if (method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(filePath).pipe(res)
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

  sendDebugState(data: LiveUiDebugStateMessage['data']): void {
    this.broadcast({ type: 'DEBUG_STATE', data })
  }

  /** 将模型原始流发给渲染进程（含 [Happy] 等标签），由前端解析表情与气泡正文。 */
  sendAssistantStream(fullRaw: string, reset = false, done = false): void {
    const data: LiveUiAssistantStreamMessage['data'] = { fullRaw, reset, done }
    this.broadcast({ type: 'ASSISTANT_STREAM', data })
  }

  /** 同步底部栏左侧状态胶囊（就绪 / 处理中 / 渲染未连接等）。 */
  sendStatusPill(label: string, variant: LiveUiStatusVariant): void {
    this.lastStatusPill = { label, variant }
    this.broadcast({ type: 'STATUS_PILL', data: { label, variant } })
  }

  /** 通知渲染端清空音频队列（新一轮 assistant 回答开始时调用）。 */
  resetAudio(): void {
    this.ttsGeneration++
    this.ttsSequence = 0
    this.ttsPending = Promise.resolve()
    this.broadcast({ type: 'AUDIO_RESET' })
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
          await engine.synthesizeStream(plain, async (out) => {
            if (generation !== this.ttsGeneration) return
            if (out.data.length === 0) return
            chunks += 1
            bytes += out.data.length
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
          })
          console.error(`[liveui] TTS 完成: ${chunks} chunks, ${bytes} bytes`)
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
      } catch (e) {
        console.warn(`[liveui] TTS 合成失败: ${(e as Error).message}`)
        if (process.env.INFINITI_AGENT_DEBUG === '1') {
          console.warn((e as Error).stack)
        }
      }
    })
  }

  private async handleVisionCaptureRequest(
    ws: WebSocket,
    message: Extract<LiveUiClientMessage, { type: 'VISION_CAPTURE_REQUEST' }>,
  ): Promise<void> {
    console.error(`[liveui] vision capture requested: ${message.requestId}, captureDelayMs=${message.captureDelayMs}`)
    const result = await captureVisionSnapshotResult({
      location: message.location,
      captureDelayMs: message.captureDelayMs,
    })
    if (result.ok) {
      this.lastVisionCapture = { requestId: message.requestId, vision: result.vision }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'VISION_CAPTURE_RESULT',
          data: { requestId: message.requestId, ok: true, vision: result.vision },
        } as LiveUiMessage))
      }
      return
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'VISION_CAPTURE_RESULT',
        data: { requestId: message.requestId, ok: false, error: result.error },
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
      if (!this.ttsEnabled) {
        this.mouth.reset()
        return
      }
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
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve())
      })
      this.httpServer = null
    }
    if (this.electronChild && !this.electronChild.killed) {
      this.electronChild.kill('SIGTERM')
      this.electronChild = null
    }
  }
}

function mediaMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.mp4' || ext === '.m4v') return 'video/mp4'
  if (ext === '.webm') return 'video/webm'
  if (ext === '.mov') return 'video/quicktime'
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  return 'application/octet-stream'
}
