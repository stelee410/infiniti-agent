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
 * audioBase64 为完整一句话的 mp3 编码（base64）；客户端按 sequence 顺序播放。
 */
export type LiveUiAudioChunkMessage = {
  type: 'AUDIO_CHUNK'
  data: {
    audioBase64: string
    format: 'mp3'
    sampleRate: number
    sequence: number
  }
}

/** 通知渲染端清空音频队列（新一轮对话开始时发送）。 */
export type LiveUiAudioResetMessage = {
  type: 'AUDIO_RESET'
}

/** 告知渲染端 TTS 引擎是否可用（连接时推送）。 */
export type LiveUiTtsStatusMessage = {
  type: 'TTS_STATUS'
  data: { available: boolean }
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
    const dd = d as { audioBase64?: unknown; format?: unknown; sampleRate?: unknown; sequence?: unknown }
    return typeof dd.audioBase64 === 'string' && typeof dd.sequence === 'number'
  }
  if (o.type === 'AUDIO_RESET' || o.type === 'INTERRUPT') return true
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
  return false
}
