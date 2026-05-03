import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import type { PersistedMessage } from '../llm/persisted.js'
import {
  avatarGenReferenceImagesFromMessages,
  imageHasTransparentPixels,
} from './real2dAvatarGen.js'

async function pngWithAlpha(alpha: number): Promise<Buffer> {
  const raw = Buffer.alloc(2 * 2 * 4, 0)
  for (let i = 0; i < raw.length; i += 4) {
    raw[i] = 255
    raw[i + 1] = 255
    raw[i + 2] = 255
    raw[i + 3] = alpha
  }
  return sharp(raw, { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer()
}

describe('imageHasTransparentPixels', () => {
  it('does not treat an opaque alpha channel as transparent background', async () => {
    await expect(imageHasTransparentPixels(await pngWithAlpha(255))).resolves.toBe(false)
    await expect(imageHasTransparentPixels(await pngWithAlpha(0))).resolves.toBe(true)
  })
})

describe('avatarGenReferenceImagesFromMessages', () => {
  it('uses the latest user image attachment as AvatarGen reference', () => {
    const messages: PersistedMessage[] = [
      { role: 'user', content: 'old', attachments: [{ id: 'old', name: 'old.png', mediaType: 'image/png', base64: 'old', size: 3, kind: 'image', capturedAt: 't0' }] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'new', attachments: [{ id: 'new', name: 'new.webp', mediaType: 'image/webp', base64: 'new', size: 3, kind: 'image', capturedAt: 't1' }] },
    ]

    expect(avatarGenReferenceImagesFromMessages(messages)).toEqual([
      { mediaType: 'image/webp', base64: 'new', label: 'new.webp' },
    ])
  })
})
