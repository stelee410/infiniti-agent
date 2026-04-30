import type { LiveUiVisionAttachment } from '../../src/liveui/protocol.ts'

export function photoDataUrl(vision: Pick<LiveUiVisionAttachment, 'mediaType' | 'imageBase64'>): string {
  return `data:${vision.mediaType};base64,${vision.imageBase64}`
}

export function scaledCaptureSize(srcW: number, srcH: number, maxSide = 640): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(srcW, srcH))
  return {
    width: Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale)),
  }
}

export function describeCameraError(e: unknown): string {
  if (e === undefined) return 'thrown value is undefined'
  if (e === null) return 'thrown value is null'
  const maybe = e as { name?: unknown; message?: unknown; stack?: unknown }
  const name = typeof maybe?.name === 'string' ? maybe.name : ''
  const message = typeof maybe?.message === 'string' ? maybe.message : ''
  const stack = typeof maybe?.stack === 'string' ? maybe.stack : ''
  const friendly =
    name === 'NotAllowedError' || name === 'SecurityError'
      ? '摄像头权限被系统拒绝'
      : name === 'NotFoundError' || name === 'DevicesNotFoundError'
        ? '没有找到可用摄像头'
        : name === 'NotReadableError' || name === 'TrackStartError'
          ? '摄像头被其他应用占用'
          : ''
  const parts = [friendly, name, message, stack].filter(Boolean)
  if (parts.length) return parts.join(' | ')
  try {
    const json = JSON.stringify(e)
    if (json && json !== '{}') return `${Object.prototype.toString.call(e)} ${json}`
  } catch {
    /* ignore */
  }
  return String(e)
}
