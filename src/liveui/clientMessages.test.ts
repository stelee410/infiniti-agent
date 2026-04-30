import { describe, expect, it } from 'vitest'
import { parseFileAttachments, parseLiveUiClientMessage, parseVisionAttachment } from './clientMessages.js'

describe('parseLiveUiClientMessage', () => {
  it('parses user input and sanitizes supported attachments', () => {
    const msg = parseLiveUiClientMessage(JSON.stringify({
      type: 'USER_INPUT',
      data: {
        line: 'hello   ',
        attachments: [
          {
            id: 'img-1',
            name: 'cat.png',
            mediaType: 'image/png',
            base64: 'aaa',
            size: 10,
            kind: 'image',
            capturedAt: '2026-04-30T00:00:00Z',
          },
          {
            id: 'bad',
            name: 'bad.exe',
            mediaType: 'application/x-msdownload',
            base64: 'bbb',
            size: 10,
            kind: 'document',
            capturedAt: '2026-04-30T00:00:00Z',
          },
        ],
      },
    }))

    expect(msg).toMatchObject({
      type: 'USER_INPUT',
      line: 'hello',
      attachments: [
        {
          id: 'img-1',
          name: 'cat.png',
          kind: 'image',
        },
      ],
    })
  })

  it('rejects invalid frames and empty user input', () => {
    expect(parseLiveUiClientMessage('not-json')).toBeNull()
    expect(parseLiveUiClientMessage(JSON.stringify({ type: 'USER_INPUT', data: { line: '   ' } }))).toBeNull()
    expect(parseLiveUiClientMessage(JSON.stringify({ type: 'NOPE', data: {} }))).toBeNull()
  })

  it('parses vision capture request with bounded delay and location', () => {
    expect(parseLiveUiClientMessage(JSON.stringify({
      type: 'VISION_CAPTURE_REQUEST',
      data: {
        requestId: 'req-1',
        captureDelayMs: 12000.8,
        location: { latitude: 31.2, longitude: 121.4, accuracy: 8 },
      },
    }))).toEqual({
      type: 'VISION_CAPTURE_REQUEST',
      requestId: 'req-1',
      captureDelayMs: 10000,
      location: { latitude: 31.2, longitude: 121.4, accuracy: 8 },
    })
  })

  it('cleans inbox ids and save-as requests', () => {
    expect(parseLiveUiClientMessage(JSON.stringify({
      type: 'INBOX_MARK_READ',
      data: { ids: [' a ', '', 42, 'b'] },
    }))).toEqual({ type: 'INBOX_MARK_READ', ids: ['a', 'b'] })

    expect(parseLiveUiClientMessage(JSON.stringify({
      type: 'INBOX_SAVE_AS',
      data: { sourcePath: '/tmp/a', destinationPath: '/tmp/b', requestId: 42 },
    }))).toEqual({
      type: 'INBOX_SAVE_AS',
      sourcePath: '/tmp/a',
      destinationPath: '/tmp/b',
      requestId: undefined,
    })
  })
})

describe('parseVisionAttachment', () => {
  it('accepts supported image media types and valid location', () => {
    expect(parseVisionAttachment({
      imageBase64: 'abc',
      mediaType: 'image/webp',
      capturedAt: 'now',
      location: { latitude: 1, longitude: 2 },
    })).toEqual({
      imageBase64: 'abc',
      mediaType: 'image/webp',
      capturedAt: 'now',
      location: { latitude: 1, longitude: 2 },
    })
  })
})

describe('parseFileAttachments', () => {
  it('caps images and trims long document text', () => {
    const attachments = parseFileAttachments([
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `img-${i}`,
        name: `${i}.png`,
        mediaType: 'image/png',
        base64: 'x',
        size: 10,
        kind: 'image',
        capturedAt: 'now',
      })),
      {
        id: 'doc',
        name: 'note.txt',
        mediaType: 'text/plain',
        base64: 'doc',
        size: 10,
        kind: 'document',
        capturedAt: 'now',
        text: 'a'.repeat(90_000),
      },
    ])

    expect(attachments.filter((a) => a.kind === 'image')).toHaveLength(9)
    expect(attachments.at(-1)?.id).toBe('doc')
    expect(attachments.at(-1)?.text).toHaveLength(80_000)
  })
})
