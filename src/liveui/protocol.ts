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
    motion?: string
  }
}

/** 原始 assistant 流（含行首 [表情] 标签）；由渲染进程解析表情并打字机显示去标签正文。 */
export type LiveUiAssistantStreamMessage = {
  type: 'ASSISTANT_STREAM'
  data: {
    fullRaw: string
    /** true：新一轮 assistant 输出开始，需清空解析状态与气泡 */
    reset?: boolean
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

export type LiveUiMessage =
  | LiveUiSyncParamMessage
  | LiveUiActionMessage
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
  if (o.type === 'ASSISTANT_STREAM') {
    const d = (x as { data?: unknown }).data
    if (!d || typeof d !== 'object') return false
    const dd = d as { fullRaw?: unknown; reset?: unknown }
    if (typeof dd.fullRaw !== 'string') return false
    if (dd.reset !== undefined && typeof dd.reset !== 'boolean') return false
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
  if (o.type === 'AUDIO_RESET' || o.type === 'INTERRUPT' || o.type === 'VISION_ATTACHMENT_CLEAR') return true
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
