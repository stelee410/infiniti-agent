import type { LiveUiFileAttachment, LiveUiVisionAttachment } from './protocol.js'

export type LiveUiInteractionKind = 'head_pat' | 'body_poke'

export type LiveUiClientMessage =
  | { type: 'USER_INPUT'; line: string; attachments: LiveUiFileAttachment[] }
  | { type: 'VISION_CAPTURE_REQUEST'; requestId: string; location?: LiveUiVisionAttachment['location']; captureDelayMs: number }
  | { type: 'VISION_CAPTURE_CONFIRM'; requestId: string; vision?: LiveUiVisionAttachment }
  | { type: 'VISION_CAPTURE_CANCEL'; requestId: string }
  | { type: 'VISION_ATTACHMENT_CLEAR' }
  | { type: 'ATTACHMENT_CLEAR' }
  | { type: 'USER_COMPOSER'; text: string }
  | { type: 'TTS_TOGGLE'; enabled: boolean }
  | { type: 'INTERRUPT' }
  | { type: 'CONFIG_SAVE'; config: unknown }
  | { type: 'INBOX_MARK_READ'; ids: string[] }
  | { type: 'INBOX_SAVE_AS'; sourcePath: string; destinationPath: string; requestId?: string }
  | { type: 'MIC_AUDIO'; audioBase64: string; format: string }
  | { type: 'LIVEUI_INTERACTION'; kind: LiveUiInteractionKind }

export function parseLiveUiClientMessage(raw: string): LiveUiClientMessage | null {
  let parsed: { type?: unknown; data?: unknown }
  try {
    parsed = JSON.parse(raw) as { type?: unknown; data?: unknown }
  } catch {
    return null
  }
  const data = record(parsed.data)
  switch (parsed.type) {
    case 'USER_INPUT': {
      if (!data) return null
      const line = typeof data.line === 'string' ? data.line : ''
      if (!line.trim()) return null
      return {
        type: 'USER_INPUT',
        line: line.trimEnd(),
        attachments: parseFileAttachments(data.attachments),
      }
    }
    case 'VISION_CAPTURE_REQUEST': {
      if (!data || typeof data.requestId !== 'string' || !data.requestId) return null
      return {
        type: 'VISION_CAPTURE_REQUEST',
        requestId: data.requestId,
        location: parseVisionLocation(data.location),
        captureDelayMs: parseCaptureDelayMs(data.captureDelayMs),
      }
    }
    case 'VISION_CAPTURE_CONFIRM': {
      if (!data || typeof data.requestId !== 'string' || !data.requestId) return null
      return {
        type: 'VISION_CAPTURE_CONFIRM',
        requestId: data.requestId,
        vision: parseVisionAttachment(data.vision),
      }
    }
    case 'VISION_CAPTURE_CANCEL': {
      if (!data || typeof data.requestId !== 'string' || !data.requestId) return null
      return { type: 'VISION_CAPTURE_CANCEL', requestId: data.requestId }
    }
    case 'VISION_ATTACHMENT_CLEAR':
      return { type: 'VISION_ATTACHMENT_CLEAR' }
    case 'ATTACHMENT_CLEAR':
      return { type: 'ATTACHMENT_CLEAR' }
    case 'USER_COMPOSER': {
      if (!data || typeof data.text !== 'string') return null
      return { type: 'USER_COMPOSER', text: data.text }
    }
    case 'TTS_TOGGLE': {
      if (!data) return null
      return { type: 'TTS_TOGGLE', enabled: !!data.enabled }
    }
    case 'INTERRUPT':
      return { type: 'INTERRUPT' }
    case 'CONFIG_SAVE':
      return data ? { type: 'CONFIG_SAVE', config: data.config } : null
    case 'INBOX_MARK_READ': {
      if (!data || !Array.isArray(data.ids)) return null
      const ids = data.ids
        .filter((x): x is string => typeof x === 'string' && !!x.trim())
        .map((x) => x.trim())
      return ids.length ? { type: 'INBOX_MARK_READ', ids } : null
    }
    case 'INBOX_SAVE_AS': {
      if (!data || typeof data.sourcePath !== 'string' || typeof data.destinationPath !== 'string') {
        return null
      }
      return {
        type: 'INBOX_SAVE_AS',
        sourcePath: data.sourcePath,
        destinationPath: data.destinationPath,
        requestId: typeof data.requestId === 'string' ? data.requestId : undefined,
      }
    }
    case 'MIC_AUDIO': {
      if (!data || typeof data.audioBase64 !== 'string') return null
      return {
        type: 'MIC_AUDIO',
        audioBase64: data.audioBase64,
        format: typeof data.format === 'string' ? data.format : 'webm',
      }
    }
    case 'LIVEUI_INTERACTION': {
      if (!data || (data.kind !== 'head_pat' && data.kind !== 'body_poke')) return null
      return { type: 'LIVEUI_INTERACTION', kind: data.kind }
    }
    default:
      return null
  }
}

function record(raw: unknown): Record<string, unknown> | undefined {
  return raw && typeof raw === 'object' ? raw as Record<string, unknown> : undefined
}

function parseCaptureDelayMs(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw)
    ? Math.max(0, Math.min(10_000, Math.round(raw)))
    : 0
}

export function parseVisionLocation(raw: unknown): LiveUiVisionAttachment['location'] | undefined {
  const loc = record(raw) as { latitude?: unknown; longitude?: unknown; accuracy?: unknown } | undefined
  if (
    !loc ||
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

export function parseVisionAttachment(raw: unknown): LiveUiVisionAttachment | undefined {
  const v = record(raw) as {
    imageBase64?: unknown
    mediaType?: unknown
    capturedAt?: unknown
    location?: unknown
  } | undefined
  if (
    !v ||
    typeof v.imageBase64 !== 'string' ||
    typeof v.capturedAt !== 'string' ||
    (v.mediaType !== 'image/jpeg' && v.mediaType !== 'image/png' && v.mediaType !== 'image/webp')
  ) {
    return undefined
  }
  const location = parseVisionLocation(v.location)
  return {
    imageBase64: v.imageBase64,
    mediaType: v.mediaType,
    capturedAt: v.capturedAt,
    ...(location ? { location } : {}),
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

export function parseFileAttachments(raw: unknown): LiveUiFileAttachment[] {
  if (!Array.isArray(raw)) return []
  const out: LiveUiFileAttachment[] = []
  let imageCount = 0
  for (const item of raw) {
    const a = record(item) as {
      id?: unknown
      name?: unknown
      mediaType?: unknown
      base64?: unknown
      size?: unknown
      kind?: unknown
      capturedAt?: unknown
      text?: unknown
    } | undefined
    if (
      !a ||
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
