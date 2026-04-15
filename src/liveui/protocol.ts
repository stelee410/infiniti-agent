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

export type LiveUiMessage =
  | LiveUiSyncParamMessage
  | LiveUiActionMessage
  | LiveUiAssistantStreamMessage
  | LiveUiStatusPillMessage

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
  return false
}
