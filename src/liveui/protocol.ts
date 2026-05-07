export type LiveUiSyncParamMessage = {
  type: 'SYNC_PARAM'
  data: {
    id: 'ParamMouthOpenY'
    value: number
  }
}

export type LiveUiActionMessage = {
  type: 'ACTION'
  data: {
    expression?: string
    intensity?: number
    motion?: string
    gaze?: string
  }
}

export type LiveUiDebugStateMessage = {
  type: 'DEBUG_STATE'
  data: {
    enabled: boolean
    emotion?: string
    emotionIntensity?: number
    relationship?: {
      trust: number
      affinity: number
      intimacy: number
      respect: number
      tension: number
    }
  }
}

/** 原始 assistant 流（含行首 [表情] 标签）；由渲染进程解析表情并打字机显示去标签正文。 */
export type LiveUiAssistantStreamMessage = {
  type: 'ASSISTANT_STREAM'
  data: {
    fullRaw: string
    /** true：新一轮 assistant 输出开始，需清空解析状态与气泡 */
    reset?: boolean
    /** true：一次性 assistant 输出已结束，可按阅读时长自动淡出气泡 */
    done?: boolean
  }
}

/** 左侧状态胶囊：文案 + 配色变体（由 Node 根据会话状态推送）。 */
export type LiveUiStatusVariant = 'ready' | 'busy' | 'warn' | 'loading'

export type LiveUiStatusPillMessage = {
  type: 'STATUS_PILL'
  data: {
    label: string
    variant: LiveUiStatusVariant
  }
}

/**
 * TTS 音频块（server → client）。
 * - mp3 / wav：audioBase64 交给 decodeAudioData。
 * - pcm_s16le：little-endian int16 交织多声道原始块；需 sampleRate + channels。
 */
export type LiveUiAudioChunkMessage = {
  type: 'AUDIO_CHUNK'
  data: {
    audioBase64: string
    format: 'mp3' | 'wav' | 'pcm_s16le'
    sampleRate: number
    sequence: number
    channels?: number
  }
}

/** 通知渲染端清空音频队列（新一轮对话开始时发送）。 */
export type LiveUiAudioResetMessage = {
  type: 'AUDIO_RESET'
}

/** 告知渲染端 TTS 引擎是否可用（连接时推送）。 */
export type LiveUiTtsStatusMessage = {
  type: 'TTS_STATUS'
  data: { available: boolean; enabled?: boolean }
}

/** 告知渲染端 ASR 是否可用（连接时推送）。 */
export type LiveUiAsrStatusMessage = {
  type: 'ASR_STATUS'
  data: { available: boolean }
}

/** ASR 识别结果（server → client），渲染端收到后填入输入框并自动提交。 */
export type LiveUiAsrResultMessage = {
  type: 'ASR_RESULT'
  data: { text: string }
}

/** 斜杠补全项（server → Live 窗口），与 TUI SlashItem 字段一致。 */
export type LiveUiSlashCompletionItem = {
  id: string
  kind: 'command' | 'tool'
  label: string
  desc: string
  insert: string
}

/** 同步 / 补全列表到渲染端（单行 / 命令模式下 open 为 true）。 */
export type LiveUiSlashCompletionMessage = {
  type: 'SLASH_COMPLETION'
  data: {
    open: boolean
    items: LiveUiSlashCompletionItem[]
  }
}

export type LiveUiConfigOpenMessage = {
  type: 'CONFIG_OPEN'
  data: {
    cwd: string
    config: unknown
  }
}

export type LiveUiConfigStatusMessage = {
  type: 'CONFIG_STATUS'
  data: {
    ok: boolean
    message: string
  }
}

export type LiveUiVisionAttachment = {
  imageBase64: string
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
  capturedAt: string
  location?: {
    latitude: number
    longitude: number
    accuracy?: number
  }
}

export type LiveUiFileAttachment = {
  id: string
  name: string
  mediaType: string
  base64: string
  size: number
  kind: 'image' | 'document'
  capturedAt: string
  text?: string
}

export type LiveUiVisionCaptureResultMessage = {
  type: 'VISION_CAPTURE_RESULT'
  data: {
    requestId: string
    ok: boolean
    vision?: LiveUiVisionAttachment
    error?: string
  }
}

export type LiveUiVisionAttachmentClearMessage = {
  type: 'VISION_ATTACHMENT_CLEAR'
  data?: Record<string, never>
}

export type LiveUiAttachmentClearMessage = {
  type: 'ATTACHMENT_CLEAR'
  data?: Record<string, never>
}

export type LiveUiInboxAttachment = {
  kind: 'image' | 'file'
  path: string
  mimeType?: string
  label?: string
}

export type LiveUiInboxItem = {
  id: string
  createdAt: string
  subject: string
  body: string
  attachments: LiveUiInboxAttachment[]
}

export type LiveUiInboxUpdateMessage = {
  type: 'INBOX_UPDATE'
  data: {
    unread: LiveUiInboxItem[]
  }
}

export type LiveUiInboxOpenMessage = {
  type: 'INBOX_OPEN'
  data: {
    items: LiveUiInboxItem[]
  }
}

export type LiveUiInboxSaveResultMessage = {
  type: 'INBOX_SAVE_RESULT'
  data: {
    ok: boolean
    message: string
  }
}

export type LiveUiH5AppletPermissions = {
  network: boolean
  storage: false | 'session'
  microphone?: boolean
  camera?: boolean
  clipboard?: boolean
  fullscreen?: boolean
}

export type LiveUiH5AppletLaunchMode = 'live_panel' | 'floating' | 'fullscreen' | 'overlay'

export type LiveUiH5AppletCreateMessage = {
  type: 'H5_APPLET_CREATE'
  data: {
    appId: string
    title: string
    description: string
    launchMode: LiveUiH5AppletLaunchMode
    permissions: LiveUiH5AppletPermissions
    html: string
    status: 'running'
  }
}

export type LiveUiH5AppletUpdateMessage = {
  type: 'H5_APPLET_UPDATE'
  data: {
    appId: string
    patchType: 'replace' | 'css' | 'state'
    content: string
  }
}

export type LiveUiH5AppletDestroyMessage = {
  type: 'H5_APPLET_DESTROY'
  data: {
    appId: string
  }
}

export type LiveUiH5AppletLibraryItem = {
  id: string
  key: string
  title: string
  description: string
  launchMode: LiveUiH5AppletLaunchMode
  updatedAt: string
}

export type LiveUiH5AppletLibraryMessage = {
  type: 'H5_APPLET_LIBRARY'
  data: {
    items: LiveUiH5AppletLibraryItem[]
  }
}

export type LiveUiH5AppletLaunchMessage = {
  type: 'H5_APPLET_LAUNCH'
  data: {
    key: string
  }
}

export type LiveUiH5AppletGenerationMessage = {
  type: 'H5_APPLET_GENERATION'
  data: {
    status: 'started' | 'completed' | 'failed'
    title: string
    description: string
    key?: string
    error?: string
  }
}

export type LiveUiMessage =
  | LiveUiSyncParamMessage
  | LiveUiActionMessage
  | LiveUiDebugStateMessage
  | LiveUiAssistantStreamMessage
  | LiveUiStatusPillMessage
  | LiveUiAudioChunkMessage
  | LiveUiAudioResetMessage
  | LiveUiTtsStatusMessage
  | LiveUiAsrStatusMessage
  | LiveUiAsrResultMessage
  | LiveUiSlashCompletionMessage
  | LiveUiConfigOpenMessage
  | LiveUiConfigStatusMessage
  | LiveUiVisionCaptureResultMessage
  | LiveUiVisionAttachmentClearMessage
  | LiveUiAttachmentClearMessage
  | LiveUiInboxUpdateMessage
  | LiveUiInboxOpenMessage
  | LiveUiInboxSaveResultMessage
  | LiveUiH5AppletCreateMessage
  | LiveUiH5AppletUpdateMessage
  | LiveUiH5AppletDestroyMessage
  | LiveUiH5AppletLibraryMessage
  | LiveUiH5AppletLaunchMessage
  | LiveUiH5AppletGenerationMessage

export function isLiveUiMessage(x: unknown): x is LiveUiMessage {
  if (!x || typeof x !== 'object') return false
  const o = x as { type?: unknown }
  if (o.type === 'SYNC_PARAM') {
    const d = (x as { data?: unknown }).data
    if (!d || typeof d !== 'object') return false
    const dd = d as { id?: unknown; value?: unknown }
    return dd.id === 'ParamMouthOpenY' && typeof dd.value === 'number'
  }
  if (o.type === 'ACTION') {
    const d = (x as { data?: unknown }).data
    if (!d || typeof d !== 'object') return false
    return true
  }
  if (o.type === 'DEBUG_STATE') {
    const d = (x as { data?: unknown }).data
    if (!d || typeof d !== 'object') return false
    return typeof (d as { enabled?: unknown }).enabled === 'boolean'
  }
  if (o.type === 'ASSISTANT_STREAM') {
    const d = (x as { data?: unknown }).data
    if (!d || typeof d !== 'object') return false
    const dd = d as { fullRaw?: unknown; reset?: unknown; done?: unknown }
    if (typeof dd.fullRaw !== 'string') return false
    if (dd.reset !== undefined && typeof dd.reset !== 'boolean') return false
    if (dd.done !== undefined && typeof dd.done !== 'boolean') return false
    return true
  }
  if (o.type === 'STATUS_PILL') {
    const d = (x as { data?: unknown }).data
    if (!d || typeof d !== 'object') return false
    const dd = d as { label?: unknown; variant?: unknown }
    if (typeof dd.label !== 'string') return false
    const v = dd.variant
    if (v !== 'ready' && v !== 'busy' && v !== 'warn' && v !== 'loading') return false
    return true
  }
  if (o.type === 'AUDIO_CHUNK') {
    const d = (x as { data?: unknown }).data
    if (!d || typeof d !== 'object') return false
    const dd = d as {
      audioBase64?: unknown
      format?: unknown
      sampleRate?: unknown
      sequence?: unknown
      channels?: unknown
    }
    if (typeof dd.audioBase64 !== 'string' || typeof dd.sequence !== 'number') return false
    if (typeof dd.sampleRate !== 'number' || !Number.isFinite(dd.sampleRate)) return false
    const fmt = dd.format
    if (fmt !== 'mp3' && fmt !== 'wav' && fmt !== 'pcm_s16le') return false
    if (fmt === 'pcm_s16le') {
      const c = dd.channels
      if (typeof c !== 'number' || (c !== 1 && c !== 2)) return false
    }
    return true
  }
  if (o.type === 'AUDIO_RESET' || o.type === 'INTERRUPT' || o.type === 'VISION_ATTACHMENT_CLEAR' || o.type === 'ATTACHMENT_CLEAR') return true
  if (o.type === 'INBOX_UPDATE' || o.type === 'INBOX_OPEN') {
    const d = (x as { data?: unknown }).data
    if (!d || typeof d !== 'object') return false
    const items = o.type === 'INBOX_UPDATE'
      ? (d as { unread?: unknown }).unread
      : (d as { items?: unknown }).items
    if (!Array.isArray(items)) return false
    return items.every((it) => {
      if (!it || typeof it !== 'object') return false
      const m = it as Record<string, unknown>
      return (
        typeof m.id === 'string' &&
        typeof m.createdAt === 'string' &&
        typeof m.subject === 'string' &&
        typeof m.body === 'string' &&
        Array.isArray(m.attachments)
      )
    })
  }
  if (o.type === 'INBOX_SAVE_RESULT') {
    const d = (x as { data?: unknown }).data
    if (!d || typeof d !== 'object') return false
    const dd = d as { ok?: unknown; message?: unknown }
    return typeof dd.ok === 'boolean' && typeof dd.message === 'string'
  }
  if (o.type === 'H5_APPLET_CREATE') {
    const d = (x as { data?: unknown }).data
    if (!d || typeof d !== 'object') return false
    const dd = d as Record<string, unknown>
    return (
      typeof dd.appId === 'string' &&
      typeof dd.title === 'string' &&
      typeof dd.description === 'string' &&
      typeof dd.html === 'string' &&
      dd.status === 'running' &&
      (dd.launchMode === 'live_panel' || dd.launchMode === 'floating' || dd.launchMode === 'fullscreen' || dd.launchMode === 'overlay') &&
      !!dd.permissions &&
      typeof dd.permissions === 'object'
    )
  }
  if (o.type === 'H5_APPLET_UPDATE') {
    const d = (x as { data?: unknown }).data
    if (!d || typeof d !== 'object') return false
    const dd = d as Record<string, unknown>
    return (
      typeof dd.appId === 'string' &&
      typeof dd.content === 'string' &&
      (dd.patchType === 'replace' || dd.patchType === 'css' || dd.patchType === 'state')
    )
  }
  if (o.type === 'H5_APPLET_DESTROY') {
    const d = (x as { data?: unknown }).data
    if (!d || typeof d !== 'object') return false
    return typeof (d as { appId?: unknown }).appId === 'string'
  }
  if (o.type === 'H5_APPLET_LIBRARY') {
    const d = (x as { data?: unknown }).data
    if (!d || typeof d !== 'object') return false
    const items = (d as { items?: unknown }).items
    return Array.isArray(items)
  }
  if (o.type === 'H5_APPLET_LAUNCH') {
    const d = (x as { data?: unknown }).data
    if (!d || typeof d !== 'object') return false
    return typeof (d as { key?: unknown }).key === 'string'
  }
  if (o.type === 'H5_APPLET_GENERATION') {
    const d = (x as { data?: unknown }).data
    if (!d || typeof d !== 'object') return false
    const dd = d as { status?: unknown; title?: unknown; description?: unknown }
    return (
      (dd.status === 'started' || dd.status === 'completed' || dd.status === 'failed') &&
      typeof dd.title === 'string' &&
      typeof dd.description === 'string'
    )
  }
  if (o.type === 'TTS_STATUS' || o.type === 'ASR_STATUS') {
    const d = (x as { data?: unknown }).data
    if (!d || typeof d !== 'object') return false
    return typeof (d as { available?: unknown }).available === 'boolean'
  }
  if (o.type === 'ASR_RESULT') {
    const d = (x as { data?: unknown }).data
    if (!d || typeof d !== 'object') return false
    return typeof (d as { text?: unknown }).text === 'string'
  }
  if (o.type === 'SLASH_COMPLETION') {
    const d = (x as { data?: unknown }).data
    if (!d || typeof d !== 'object') return false
    const dd = d as { open?: unknown; items?: unknown }
    if (typeof dd.open !== 'boolean' || !Array.isArray(dd.items)) return false
    return dd.items.every((it) => {
      if (!it || typeof it !== 'object') return false
      const o2 = it as Record<string, unknown>
      return (
        typeof o2.id === 'string' &&
        (o2.kind === 'command' || o2.kind === 'tool') &&
        typeof o2.label === 'string' &&
        typeof o2.desc === 'string' &&
        typeof o2.insert === 'string'
      )
    })
  }
  if (o.type === 'CONFIG_OPEN') {
    const d = (x as { data?: unknown }).data
    if (!d || typeof d !== 'object') return false
    const dd = d as { cwd?: unknown; config?: unknown }
    return typeof dd.cwd === 'string' && !!dd.config && typeof dd.config === 'object'
  }
  if (o.type === 'CONFIG_STATUS') {
    const d = (x as { data?: unknown }).data
    if (!d || typeof d !== 'object') return false
    const dd = d as { ok?: unknown; message?: unknown }
    return typeof dd.ok === 'boolean' && typeof dd.message === 'string'
  }
  if (o.type === 'VISION_CAPTURE_RESULT') {
    const d = (x as { data?: unknown }).data
    if (!d || typeof d !== 'object') return false
    const dd = d as { requestId?: unknown; ok?: unknown }
    return typeof dd.requestId === 'string' && typeof dd.ok === 'boolean'
  }
  return false
}
