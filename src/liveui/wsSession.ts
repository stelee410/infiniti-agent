import { type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createReadStream, createWriteStream, statSync, type WriteStream } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
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
  LiveUiH5AppletLibraryItem,
  LiveUiAssistantVoiceMessage,
  LiveUiRecordingControlMessage,
} from './protocol.js'
import { parseSpeakCommandLine } from './speakCommandLine.js'
import { StreamMouthEstimator } from './streamMouth.js'
import type { TtsEngine } from '../tts/engine.js'
import { markdownToTtsPlainText } from '../tts/markdownToTtsPlainText.js'
import type { AsrEngine } from '../asr/whisperAsr.js'
import { captureVisionSnapshotResult } from './visionCapture.js'
import { parseLiveUiClientMessage, type LiveUiClientMessage } from './clientMessages.js'
import {
  H5AppletManager,
  type H5AppletCreateInput,
  type H5AppletPatchType,
  type H5AppletRecord,
} from './appletRuntime.js'

export type LiveUiConnectionListener = (connected: boolean) => void
export type LiveUiUserLineListener = (line: string) => void
export type LiveUiCallModeListener = () => void
export type LiveUiCallUserInputListener = (text: string) => void
/** 渲染端输入框草稿（含未发送的 `/` 前缀），用于与 TUI 同步斜杠补全。 */
export type LiveUiUserComposerListener = (text: string) => void
export type LiveUiInterruptListener = () => void
export type LiveUiConfigSaveListener = (config: unknown) => void
export type LiveUiInboxMarkReadListener = (ids: string[]) => void
export type LiveUiInboxSaveAsListener = (sourcePath: string, destinationPath: string, requestId?: string) => void

/** 渲染端点击 Live2D 头部 / 身体等，由 Node 转成一条合成用户消息请求模型回应 */
export type LiveUiInteractionKind = 'head_pat' | 'body_poke'
export type LiveUiInteractionListener = (kind: LiveUiInteractionKind) => void
export type LiveUiAppletEvent = {
  appId: string
  title?: string
  event: string
  payload: unknown
  receivedAt: string
}
export type LiveUiAppletEventListener = (event: LiveUiAppletEvent) => void
export type LiveUiAppletLaunchListener = (key: string) => void

export function isAllowedLiveUiMediaPath(filePath: string, roots: string[]): boolean {
  const target = resolve(filePath)
  return roots.some((root) => {
    const rel = relative(resolve(root), target)
    return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
  })
}

type AssistantVoiceExportState = {
  generation: number
  selected: boolean
  started: boolean
  finalized: boolean
}

type AssistantMediaPending = {
  resolve: (result: { ok: boolean; error?: string }) => void
  timer: ReturnType<typeof setTimeout>
}

export type AssistantMediaSendResult = { ok: boolean; error?: string; requestId: string }

let assistantMediaSeq = 0

function nextAssistantMediaRequestId(): string {
  assistantMediaSeq += 1
  return `am-${Date.now().toString(36)}-${assistantMediaSeq}`
}

/** 录音默认上限 2 小时；客户端与服务端双重兜底。 */
const RECORDING_MAX_MS = 2 * 60 * 60 * 1000
/** MediaRecorder 分片间隔：1s 一片，流式回传追加写盘。 */
const RECORDING_TIMESLICE_MS = 1000
const RECORDING_START_ACK_MS = 8000
const RECORDING_STOP_ACK_MS = 6000

export type RecordingStartResult =
  | { ok: true; recordingId: string; path: string }
  | { ok: false; error: string }
export type RecordingStopResult =
  | { ok: true; path: string; durationMs: number; bytes: number }
  | { ok: false; error: string }
export type RecordingStatus =
  | { active: false }
  | { active: true; recordingId: string; startedAt: number; durationMs: number; path: string; bytes: number }

type RecordingState = {
  id: string
  startedAt: number
  path: string
  stream: WriteStream | null
  bytes: number
  chunks: number
  maxMs: number
  status: 'starting' | 'recording' | 'stopping'
  capTimer: ReturnType<typeof setTimeout> | null
  ackResolve: ((r: RecordingStartResult) => void) | null
  ackTimer: ReturnType<typeof setTimeout> | null
  stopResolve: ((r: RecordingStopResult) => void) | null
  stopTimer: ReturnType<typeof setTimeout> | null
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
  private callModeStartListeners = new Set<LiveUiCallModeListener>()
  private callModeEndListeners = new Set<LiveUiCallModeListener>()
  private callUserInputListeners = new Set<LiveUiCallUserInputListener>()
  private interruptListeners = new Set<LiveUiInterruptListener>()
  private configSaveListeners = new Set<LiveUiConfigSaveListener>()
  private inboxMarkReadListeners = new Set<LiveUiInboxMarkReadListener>()
  private inboxSaveAsListeners = new Set<LiveUiInboxSaveAsListener>()
  private interactionListeners = new Set<LiveUiInteractionListener>()
  private appletEventListeners = new Set<LiveUiAppletEventListener>()
  private appletLaunchListeners = new Set<LiveUiAppletLaunchListener>()
  private applets = new H5AppletManager()
  private mouthTimer: ReturnType<typeof setInterval> | undefined
  private electronChild: ChildProcess | null = null
  private ttsEngine: TtsEngine | null = null
  private ttsEnabled = true
  private ttsSequence = 0
  private ttsPending: Promise<void> = Promise.resolve()
  private ttsGeneration = 0
  private voiceExport: AssistantVoiceExportState | null = null
  private assistantMediaPending = new Map<string, AssistantMediaPending>()
  private asrEngine: AsrEngine | null = null
  private lastVisionCapture: { requestId: string; vision: LiveUiVisionAttachment } | undefined
  private pendingVisionAttachment: LiveUiVisionAttachment | undefined
  private pendingFileAttachments: LiveUiFileAttachment[] = []
  private lastStatusPill: { label: string; variant: LiveUiStatusVariant } = { label: '就绪', variant: 'ready' }
  private lastAppletLibrary: LiveUiH5AppletLibraryItem[] = []

  private readonly mediaRoots: string[]
  private readonly assistantVoicePossible: number
  private readonly streamTtsPlayback: boolean
  private readonly random: () => number
  /** 录音落盘目录（.infiniti-agent/workspace/recordings/）；未配置则录音不可用。 */
  private readonly recordingsDir: string | null
  private recording: RecordingState | null = null

  constructor(port: number, opts: {
    mediaRoots?: string[]
    assistantVoicePossible?: number
    streamTtsPlayback?: boolean
    random?: () => number
    recordingsDir?: string
  } = {}) {
    this.port = port
    this.mediaRoots = (opts.mediaRoots ?? []).map((p) => resolve(p))
    this.assistantVoicePossible = clampProbability(opts.assistantVoicePossible ?? 0)
    this.streamTtsPlayback = opts.streamTtsPlayback ?? true
    this.random = opts.random ?? Math.random
    this.recordingsDir = opts.recordingsDir ? resolve(opts.recordingsDir) : null
  }

  setTtsEnabled(enabled: boolean): void {
    this.ttsEnabled = enabled
    if (!enabled) {
      this.resetAudio()
      this.mouth.reset()
      this.sendMouth(0)
    }
    this.broadcastTtsStatus()
    this.broadcastCallAvailability()
  }

  setTtsEngine(engine: TtsEngine | null): void {
    this.ttsEngine = engine
    this.broadcastTtsStatus()
    this.broadcastCallAvailability()
  }

  private broadcastTtsStatus(): void {
    this.broadcast({ type: 'TTS_STATUS', data: { available: this.ttsEngine != null, enabled: this.ttsEnabled } } as LiveUiMessage)
  }

  setAsrEngine(engine: AsrEngine | null): void {
    this.asrEngine = engine
    this.broadcastAsrStatus()
    this.broadcastCallAvailability()
  }

  private broadcastAsrStatus(): void {
    this.broadcast({ type: 'ASR_STATUS', data: { available: this.asrEngine != null } } as LiveUiMessage)
  }

  private callAvailabilityPayload(): { asr: boolean; tts: boolean; reasons?: string[] } {
    const asr = this.asrEngine != null
    const tts = this.ttsEngine != null && this.ttsEnabled
    const reasons: string[] = []
    if (!asr) reasons.push('ASR 引擎未就绪：请在 config.json 配置 sherpa_onnx 或 whisper 并重启。')
    if (!tts) reasons.push('TTS 服务未就绪：请确认 VoxCPM / 其它 TTS 已启动且健康。')
    return reasons.length ? { asr, tts, reasons } : { asr, tts }
  }

  private broadcastCallAvailability(): void {
    this.broadcast({ type: 'CALL_AVAILABILITY', data: this.callAvailabilityPayload() } as LiveUiMessage)
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

  /** 通话模式：CALL_MODE_START / CALL_MODE_END / CALL_USER_INPUT 监听 */
  onCallModeStart(fn: LiveUiCallModeListener): () => void {
    this.callModeStartListeners.add(fn)
    return () => { this.callModeStartListeners.delete(fn) }
  }

  onCallModeEnd(fn: LiveUiCallModeListener): () => void {
    this.callModeEndListeners.add(fn)
    return () => { this.callModeEndListeners.delete(fn) }
  }

  onCallUserInput(fn: LiveUiCallUserInputListener): () => void {
    this.callUserInputListeners.add(fn)
    return () => { this.callUserInputListeners.delete(fn) }
  }

  private emitCallModeStart(): void { for (const f of this.callModeStartListeners) f() }
  private emitCallModeEnd(): void { for (const f of this.callModeEndListeners) f() }
  private emitCallUserInput(text: string): void {
    for (const f of this.callUserInputListeners) f(text)
  }

  /** 立即向当前已连接的客户端广播一次 CALL_AVAILABILITY；连接 onopen 调用。 */
  sendCallAvailabilityTo(ws: WebSocket): void {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'CALL_AVAILABILITY', data: this.callAvailabilityPayload() }))
  }

  consumePendingVisionAttachment(): LiveUiVisionAttachment | undefined {
    const vision = this.pendingVisionAttachment
    this.pendingVisionAttachment = undefined
    return vision
  }

  /** 暂存一张视觉附件（如截屏），它会挂到用户下一条消息上一起发给 LLM。 */
  stagePendingVision(vision: LiveUiVisionAttachment): void {
    this.pendingVisionAttachment = vision
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

  onAppletEvent(fn: LiveUiAppletEventListener): () => void {
    this.appletEventListeners.add(fn)
    return () => {
      this.appletEventListeners.delete(fn)
    }
  }

  private emitAppletEvent(event: LiveUiAppletEvent): void {
    for (const f of this.appletEventListeners) {
      f(event)
    }
  }

  onAppletLaunch(fn: LiveUiAppletLaunchListener): () => void {
    this.appletLaunchListeners.add(fn)
    return () => {
      this.appletLaunchListeners.delete(fn)
    }
  }

  private emitAppletLaunch(key: string): void {
    for (const f of this.appletLaunchListeners) {
      f(key)
    }
  }

  launchH5Applet(key: string): void {
    this.broadcast({ type: 'H5_APPLET_LAUNCH', data: { key } } as LiveUiMessage)
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
        this.sendCallAvailabilityTo(ws)
        ws.send(JSON.stringify({ type: 'STATUS_PILL', data: this.lastStatusPill }))
        ws.send(JSON.stringify({ type: 'H5_APPLET_LIBRARY', data: { items: this.lastAppletLibrary } }))
        for (const applet of this.applets.list()) {
          if (applet.status !== 'destroyed') ws.send(JSON.stringify(this.appletCreateMessage(applet)))
        }
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
        this.finalizeRecordingIfClientGone()
      })
      ws.on('error', () => {
        this.clients.delete(ws)
        this.emitConn()
        this.finalizeRecordingIfClientGone()
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
          void this.handleMicAudio(message.audioBase64, message.format, ws, message.transcribeOnly === true)
        }
        return
      case 'LIVEUI_INTERACTION':
        this.emitInteraction(message.kind)
        return
      case 'H5_APPLET_EVENT':
        const applet = this.applets.get(message.appId)
        this.emitAppletEvent({
          appId: message.appId,
          title: applet?.title,
          event: message.event,
          payload: message.payload,
          receivedAt: new Date().toISOString(),
        })
        return
      case 'H5_APPLET_CLOSE_REQUEST':
        try {
          this.destroyH5Applet(message.appId)
        } catch {
          this.broadcast({ type: 'H5_APPLET_DESTROY', data: { appId: message.appId } } as LiveUiMessage)
        }
        return
      case 'H5_APPLET_LAUNCH_REQUEST':
        this.emitAppletLaunch(message.key)
        return
      case 'ASSISTANT_MEDIA_RESULT':
        this.handleAssistantMediaResult(message.requestId, message.ok, message.error)
        return
      case 'CALL_MODE_START':
        this.emitCallModeStart()
        return
      case 'CALL_MODE_END':
        this.emitCallModeEnd()
        return
      case 'CALL_USER_INPUT':
        this.emitCallUserInput(message.text)
        return
      case 'REC_STARTED':
        this.onRecStarted(message.recordingId)
        return
      case 'REC_CHUNK':
        this.onRecChunk(message.recordingId, message.audioBase64, message.sequence)
        return
      case 'REC_STOPPED':
        this.onRecStopped(message.recordingId)
        return
      case 'REC_ERROR':
        this.onRecError(message.recordingId, message.error)
        return
    }
  }

  /** 给已连接的客户端（headless 模式下通常是 bridge）发送一份媒体投递请求，等待回执。 */
  async sendAssistantMedia(args: {
    filePath: string
    kind: 'image' | 'video' | 'file'
    caption?: string
    timeoutMs?: number
  }): Promise<AssistantMediaSendResult> {
    const requestId = nextAssistantMediaRequestId()
    const timeoutMs = args.timeoutMs ?? 60_000
    if (this.clients.size === 0) {
      return { ok: false, error: 'no live client connected', requestId }
    }
    const promise = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const timer = setTimeout(() => {
        if (this.assistantMediaPending.delete(requestId)) {
          resolve({ ok: false, error: `media send timed out after ${timeoutMs}ms` })
        }
      }, timeoutMs)
      this.assistantMediaPending.set(requestId, { resolve, timer })
    })
    this.broadcast({
      type: 'ASSISTANT_MEDIA',
      data: {
        requestId,
        filePath: args.filePath,
        kind: args.kind,
        ...(args.caption ? { caption: args.caption } : {}),
      },
    } as LiveUiMessage)
    const result = await promise
    return { ...result, requestId }
  }

  private handleAssistantMediaResult(requestId: string, ok: boolean, error: string | undefined): void {
    const pending = this.assistantMediaPending.get(requestId)
    if (!pending) return
    this.assistantMediaPending.delete(requestId)
    clearTimeout(pending.timer)
    pending.resolve({ ok, ...(error ? { error } : {}) })
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

  createH5Applet(input: H5AppletCreateInput): H5AppletRecord {
    const applet = this.applets.create(input)
    this.broadcast(this.appletCreateMessage(applet))
    return applet
  }

  updateH5Applet(appId: string, patchType: H5AppletPatchType, content: string): H5AppletRecord {
    const applet = this.applets.update({ appId, patchType, content })
    this.broadcast({
      type: 'H5_APPLET_UPDATE',
      data: {
        appId,
        patchType,
        content: patchType === 'replace' ? applet.html : content,
      },
    } as LiveUiMessage)
    if (patchType !== 'replace') this.applets.markRunning(appId)
    return this.applets.get(appId) ?? applet
  }

  destroyH5Applet(appId: string): H5AppletRecord {
    const applet = this.applets.destroy(appId)
    this.broadcast({ type: 'H5_APPLET_DESTROY', data: { appId } } as LiveUiMessage)
    return applet
  }

  sendH5AppletLibrary(items: LiveUiH5AppletLibraryItem[]): void {
    this.lastAppletLibrary = items
    this.broadcast({ type: 'H5_APPLET_LIBRARY', data: { items } } as LiveUiMessage)
  }

  sendH5AppletGeneration(data: {
    status: 'started' | 'completed' | 'failed'
    title: string
    description: string
    key?: string
    error?: string
  }): void {
    this.broadcast({ type: 'H5_APPLET_GENERATION', data } as LiveUiMessage)
  }

  private appletCreateMessage(applet: H5AppletRecord): LiveUiMessage {
    return {
      type: 'H5_APPLET_CREATE',
      data: {
        appId: applet.appId,
        title: applet.title,
        description: applet.description,
        launchMode: applet.launchMode,
        permissions: applet.permissions,
        html: applet.html,
        status: 'running',
      },
    } as LiveUiMessage
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

  /** 工具活动可视化（桌面伴侣 GUI v0·B）：同一 id 由 start → done/error 更新同张卡片。 */
  sendActivity(data: { id: string; tool: string; status: 'start' | 'done' | 'error'; summary?: string }): void {
    this.broadcast({ type: 'ACTIVITY', data } as LiveUiMessage)
  }

  /** 工具需用户确认（GUI v0.5）：就地弹「允许/拒绝」，一键放行复用对话式审批。 */
  sendApprovalRequest(data: { id: string; tool: string; summary?: string }): void {
    this.broadcast({ type: 'APPROVAL_REQUEST', data } as LiveUiMessage)
  }

  /** 通知渲染端清空音频队列（新一轮 assistant 回答开始时调用）。 */
  resetAudio(): void {
    this.ttsGeneration++
    this.ttsSequence = 0
    this.ttsPending = Promise.resolve()
    this.broadcast({ type: 'AUDIO_RESET' })
  }

  beginAssistantTurn(): void {
    this.resetAudio()
    this.startAssistantVoiceExportTurn()
  }

  private startAssistantVoiceExportTurn(): void {
    const selected =
      this.assistantVoicePossible > 0 &&
      this.ttsEngine != null &&
      this.ttsEnabled &&
      this.random() < this.assistantVoicePossible
    this.voiceExport = {
      generation: this.ttsGeneration,
      selected,
      started: false,
      finalized: false,
    }
    if (selected) {
      this.voiceExport.started = true
      this.broadcast({ type: 'ASSISTANT_VOICE', data: { status: 'started' } } as LiveUiAssistantVoiceMessage)
    }
  }

  async finalizeAssistantVoice(text: string): Promise<void> {
    const state = this.voiceExport
    if (!state || state.generation !== this.ttsGeneration || state.finalized || !state.selected) return
    state.finalized = true
    const plain = markdownToTtsPlainText(text)
    if (!plain.trim() || !this.ttsEngine || !this.ttsEnabled) {
      console.error(`[liveui] voice export 跳过：text=${plain.length} hasEngine=${!!this.ttsEngine} ttsEnabled=${this.ttsEnabled}`)
      this.broadcast({ type: 'ASSISTANT_VOICE', data: { status: 'skipped' } } as LiveUiAssistantVoiceMessage)
      return
    }
    const engine = this.ttsEngine
    const generation = this.ttsGeneration
    try {
      const out = await synthesizeAssistantVoiceForExport(engine, plain)
      if (generation !== this.ttsGeneration) {
        console.error(`[liveui] voice export 终止：本轮 generation 已变更`)
        return
      }
      if (!out || out.data.length === 0) {
        console.warn(`[liveui] voice export 失败：合成无音频`)
        this.broadcast({ type: 'ASSISTANT_VOICE', data: { status: 'failed', error: 'no audio produced' } } as LiveUiAssistantVoiceMessage)
        return
      }
      const filePath = await writeAssistantVoiceFile(out)
      console.error(`[liveui] voice export 文件写入: ${filePath} (${out.data.length}B, ${out.format} ${out.sampleRate}Hz)`)
      const data: Extract<LiveUiAssistantVoiceMessage['data'], { status: 'completed' }> = {
        status: 'completed',
        format: out.format,
        sampleRate: out.sampleRate,
        filePath,
      }
      if (out.channels != null) data.channels = out.channels
      this.broadcast({ type: 'ASSISTANT_VOICE', data } as LiveUiAssistantVoiceMessage)
    } catch (e) {
      if (generation !== this.ttsGeneration) return
      console.warn(`[liveui] voice export 抛错: ${(e as Error).message}`)
      this.broadcast({
        type: 'ASSISTANT_VOICE',
        data: { status: 'failed', error: (e as Error).message },
      } as LiveUiAssistantVoiceMessage)
    }
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

  private async handleMicAudio(audioBase64: string, format: string, ws: WebSocket, transcribeOnly: boolean): Promise<void> {
    if (!this.asrEngine) return
    try {
      const buf = Buffer.from(audioBase64, 'base64')
      const text = await this.asrEngine.transcribe(buf, format)
      // 即使空文本也回 ASR_RESULT，渲染端能据此关闭「识别中…」UI 并恢复输入框。
      const result = JSON.stringify({ type: 'ASR_RESULT', data: { text: text.trim() } })
      if (ws.readyState === WebSocket.OPEN) ws.send(result)
      if (!text.trim()) return
      // transcribeOnly：仅把识别结果回给渲染端填入输入框，不自动走 user line → LLM。
      if (!transcribeOnly) this.emitUserLine(text.trim())
    } catch (e) {
      console.warn(`[liveui] ASR 识别失败: ${(e as Error).message}`)
    }
  }

  // ===== 录音（独立连续采集，不走 ASR 的 MIC_AUDIO 分片） =====

  /**
   * 开始一段麦克风录音。让渲染端起一个专用 MediaRecorder 连续采集，分片回传追加写盘。
   * 返回 promise：客户端确认开始（REC_STARTED）后 resolve 成功，权限失败/无客户端/超时则失败。
   */
  startRecording(opts: { maxMs?: number } = {}): Promise<RecordingStartResult> {
    if (!this.recordingsDir) {
      return Promise.resolve({ ok: false, error: '录音未配置落盘目录（需 LiveUI 模式）' })
    }
    if (this.recording) {
      return Promise.resolve({ ok: false, error: '已有录音在进行，请先停止' })
    }
    if (this.clients.size === 0) {
      return Promise.resolve({ ok: false, error: '未连接 LiveUI 客户端，无法采集麦克风' })
    }
    const id = `rec-${Date.now().toString(36)}-${Math.floor(this.random() * 1e6).toString(36)}`
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const path = join(this.recordingsDir, `${stamp}-${id}.webm`)
    const maxMs = Math.max(1000, Math.min(RECORDING_MAX_MS, opts.maxMs ?? RECORDING_MAX_MS))
    const state: RecordingState = {
      id,
      startedAt: Date.now(),
      path,
      stream: null,
      bytes: 0,
      chunks: 0,
      maxMs,
      status: 'starting',
      capTimer: null,
      ackResolve: null,
      ackTimer: null,
      stopResolve: null,
      stopTimer: null,
    }
    this.recording = state
    const promise = new Promise<RecordingStartResult>((resolve) => {
      state.ackResolve = resolve
      state.ackTimer = setTimeout(() => {
        // 客户端无响应：清理状态（很可能是麦克风未授权或渲染端未实现）。
        if (this.recording === state && state.status === 'starting') {
          this.recording = null
          this.resolveStart(state, { ok: false, error: '客户端无响应（麦克风未授权？）' })
        }
      }, RECORDING_START_ACK_MS)
    })
    this.broadcast({
      type: 'RECORDING_CONTROL',
      data: { action: 'start', recordingId: id, maxMs, timesliceMs: RECORDING_TIMESLICE_MS },
    } as LiveUiRecordingControlMessage as LiveUiMessage)
    return promise
  }

  /** 停止当前录音并 finalize 文件。返回最终路径/时长/字节数。 */
  stopRecording(): Promise<RecordingStopResult> {
    const state = this.recording
    if (!state) return Promise.resolve({ ok: false, error: '当前没有在录音' })
    if (state.status === 'stopping' && state.stopResolve) {
      return Promise.resolve({ ok: false, error: '正在停止中' })
    }
    state.status = 'stopping'
    const promise = new Promise<RecordingStopResult>((resolve) => {
      state.stopResolve = resolve
      state.stopTimer = setTimeout(() => {
        // 客户端没回 REC_STOPPED：用已落盘内容兜底 finalize。
        void this.finalizeRecording(state, 'timeout')
      }, RECORDING_STOP_ACK_MS)
    })
    this.broadcast({
      type: 'RECORDING_CONTROL',
      data: { action: 'stop', recordingId: state.id },
    } as LiveUiRecordingControlMessage as LiveUiMessage)
    return promise
  }

  recordingStatus(): RecordingStatus {
    const s = this.recording
    if (!s) return { active: false }
    return {
      active: true,
      recordingId: s.id,
      startedAt: s.startedAt,
      durationMs: Date.now() - s.startedAt,
      path: s.path,
      bytes: s.bytes,
    }
  }

  private onRecStarted(recordingId: string): void {
    const state = this.recording
    if (!state || state.id !== recordingId || state.status !== 'starting') return
    void this.beginRecordingFile(state)
  }

  private async beginRecordingFile(state: RecordingState): Promise<void> {
    try {
      await mkdir(this.recordingsDir!, { recursive: true })
      state.stream = createWriteStream(state.path)
    } catch (e) {
      if (this.recording === state) this.recording = null
      this.resolveStart(state, { ok: false, error: `创建录音文件失败：${(e as Error).message}` })
      return
    }
    if (this.recording !== state) {
      // 期间被取消
      state.stream.end()
      return
    }
    state.status = 'recording'
    state.startedAt = Date.now()
    state.capTimer = setTimeout(() => {
      // 服务端 2h 兜底：通知客户端停止（客户端通常已自停）。
      this.broadcast({
        type: 'RECORDING_CONTROL',
        data: { action: 'stop', recordingId: state.id },
      } as LiveUiRecordingControlMessage as LiveUiMessage)
      void this.finalizeRecording(state, 'maxDuration')
    }, state.maxMs)
    this.resolveStart(state, { ok: true, recordingId: state.id, path: state.path })
  }

  private onRecChunk(recordingId: string, audioBase64: string, _sequence: number): void {
    const state = this.recording
    if (!state || state.id !== recordingId || !state.stream || state.status === 'starting') return
    const buf = Buffer.from(audioBase64, 'base64')
    state.bytes += buf.length
    state.chunks += 1
    state.stream.write(buf)
  }

  private onRecStopped(recordingId: string): void {
    const state = this.recording
    if (!state || state.id !== recordingId) return
    void this.finalizeRecording(state, 'client')
  }

  private onRecError(recordingId: string, error: string): void {
    const state = this.recording
    if (!state || state.id !== recordingId) return
    if (state.status === 'starting') {
      this.recording = null
      this.resolveStart(state, { ok: false, error })
      return
    }
    void this.finalizeRecording(state, 'error')
  }

  /** 采集客户端断连时，把已落盘的录音 finalize，不丢已录部分。 */
  private finalizeRecordingIfClientGone(): void {
    if (this.recording && this.clients.size === 0) {
      void this.finalizeRecording(this.recording, 'disconnect')
    }
  }

  private resolveStart(state: RecordingState, result: RecordingStartResult): void {
    if (state.ackTimer) { clearTimeout(state.ackTimer); state.ackTimer = null }
    const resolve = state.ackResolve
    state.ackResolve = null
    resolve?.(result)
  }

  /** 关闭写流、清理定时器、resolve 等待中的 stop promise。幂等。 */
  private async finalizeRecording(state: RecordingState, _reason: string): Promise<void> {
    if (this.recording !== state) return
    this.recording = null
    if (state.capTimer) { clearTimeout(state.capTimer); state.capTimer = null }
    if (state.ackTimer) { clearTimeout(state.ackTimer); state.ackTimer = null }
    if (state.stopTimer) { clearTimeout(state.stopTimer); state.stopTimer = null }
    if (state.stream) {
      await new Promise<void>((resolve) => state.stream!.end(() => resolve()))
    }
    const durationMs = Date.now() - state.startedAt
    const stopResolve = state.stopResolve
    state.stopResolve = null
    if (state.bytes > 0) {
      stopResolve?.({ ok: true, path: state.path, durationMs, bytes: state.bytes })
    } else {
      stopResolve?.({ ok: false, error: '没有录到任何音频数据' })
    }
  }

  get hasTts(): boolean {
    return this.ttsEngine != null && this.ttsEnabled
  }

  get shouldStreamTtsPlayback(): boolean {
    return this.hasTts && this.streamTtsPlayback
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
    if (this.recording) {
      await this.finalizeRecording(this.recording, 'dispose')
    }
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

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

/**
 * Headless 语音导出：优先走 stream，已收音频后再开始计 2 秒 idle，超时则主动 abort 上游并落盘；
 * 不支持 stream 的引擎走整段 synthesize。
 */
async function synthesizeAssistantVoiceForExport(
  engine: TtsEngine,
  text: string,
): Promise<
  | {
      data: Buffer
      format: 'mp3' | 'wav' | 'pcm_s16le'
      sampleRate: number
      channels?: number
    }
  | undefined
> {
  if (!engine.synthesizeStream) {
    console.error(`[liveui] voice export 走 synthesize（非流式）`)
    const out = await engine.synthesize(text)
    if (out.data.length === 0) return undefined
    return out
  }

  const controller = new AbortController()
  let idleTimer: NodeJS.Timeout | undefined
  const IDLE_MS = 2000
  let aborted = false
  let chunkCount = 0
  let totalBytes = 0
  let firstChunkAt = 0
  const tStart = Date.now()
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      aborted = true
      const since = Date.now() - tStart
      console.error(`[liveui] voice export idle ${IDLE_MS}ms 截断（已收 ${chunkCount} chunks / ${totalBytes} bytes，总耗时 ${since}ms）`)
      controller.abort()
    }, IDLE_MS)
  }

  const pcmChunks: Buffer[] = []
  let pcmSampleRate = 0
  let pcmChannels = 1
  let wholeBuffer: Buffer | undefined
  let wholeFormat: 'mp3' | 'wav' | undefined
  let wholeSampleRate = 0

  console.error(`[liveui] voice export 开始 stream: ${text.slice(0, 60)}${text.length > 60 ? '…' : ''}`)
  try {
    await engine.synthesizeStream(text, async (out) => {
      if (out.data.length === 0) return
      chunkCount += 1
      totalBytes += out.data.length
      if (!firstChunkAt) {
        firstChunkAt = Date.now()
        console.error(`[liveui] voice export 首包: ${out.format} ${out.sampleRate}Hz ${out.channels ?? 1}ch ${out.data.length}B (首包 ${firstChunkAt - tStart}ms)`)
      }
      if (out.format === 'pcm_s16le') {
        pcmChunks.push(out.data)
        if (!pcmSampleRate) pcmSampleRate = out.sampleRate
        if (out.channels != null) pcmChannels = out.channels
      } else {
        wholeBuffer = wholeBuffer ? Buffer.concat([wholeBuffer, out.data]) : out.data
        wholeFormat = out.format
        wholeSampleRate = out.sampleRate
      }
      // 收到第一块后才开始计 idle；之后每收到一块就重置。
      armIdle()
    }, controller.signal)
  } catch (e) {
    if (!aborted) {
      // Real upstream error; only swallow if we already collected usable audio.
      const haveAny = pcmChunks.length > 0 || (wholeBuffer && wholeBuffer.length > 0)
      if (!haveAny) throw e
      console.warn(`[liveui] voice export stream 抛错但已有音频，落盘已收部分: ${(e as Error).message}`)
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
  }

  const elapsed = Date.now() - tStart
  console.error(`[liveui] voice export 完成: chunks=${chunkCount} bytes=${totalBytes} elapsed=${elapsed}ms aborted=${aborted}`)

  if (wholeBuffer && wholeBuffer.length > 0 && wholeFormat) {
    return { data: wholeBuffer, format: wholeFormat, sampleRate: wholeSampleRate }
  }
  if (pcmChunks.length === 0) return undefined
  const pcm = Buffer.concat(pcmChunks)
  if (pcm.length === 0) return undefined
  const wav = pcm16leToWavBuffer(pcm, pcmSampleRate || 24000, pcmChannels)
  return { data: wav, format: 'wav', sampleRate: pcmSampleRate || 24000 }
}

function pcm16leToWavBuffer(pcm: Buffer, sampleRate: number, numChannels: number): Buffer {
  const bitsPerSample = 16
  const blockAlign = (numChannels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign
  const dataSize = pcm.length
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(numChannels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)
  return Buffer.concat([header, pcm])
}

async function writeAssistantVoiceFile(out: {
  data: Buffer
  format: 'mp3' | 'wav' | 'pcm_s16le'
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'infiniti-agent-voice-'))
  const ext = out.format === 'mp3' ? 'mp3' : 'wav'
  const filePath = join(dir, `reply.${ext}`)
  await writeFile(filePath, out.data)
  return filePath
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
