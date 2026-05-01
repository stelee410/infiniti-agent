import { describe, expect, it } from 'vitest'
import {
  describeCameraError,
  photoDataUrl,
  scaledCaptureSize,
} from './cameraUtils.ts'

describe('cameraUtils', () => {
  it('formats vision attachments as data URLs', () => {
    expect(photoDataUrl({ mediaType: 'image/jpeg', imageBase64: 'abc' })).toBe('data:image/jpeg;base64,abc')
  })

  it('scales captured frames to fit a max side while preserving small frames', () => {
    expect(scaledCaptureSize(1280, 720)).toEqual({ width: 640, height: 360 })
    expect(scaledCaptureSize(320, 200)).toEqual({ width: 320, height: 200 })
    expect(scaledCaptureSize(0, 0)).toEqual({ width: 1, height: 1 })
  })

  it('describes common camera errors with friendly context', () => {
    expect(describeCameraError(undefined)).toBe('thrown value is undefined')
    expect(describeCameraError(null)).toBe('thrown value is null')
    expect(describeCameraError({ name: 'NotAllowedError', message: 'denied' })).toContain('摄像头权限被系统拒绝')
    expect(describeCameraError({ name: 'NotFoundError' })).toContain('没有找到可用摄像头')
    expect(describeCameraError({ name: 'NotReadableError' })).toContain('摄像头被其他应用占用')
    expect(describeCameraError({ code: 'x' })).toContain('[object Object]')
  })
})
