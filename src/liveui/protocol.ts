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

export type LiveUiMessage = LiveUiSyncParamMessage | LiveUiActionMessage

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
  return false
}
