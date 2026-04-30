import { describe, expect, it } from 'vitest'
import {
  filePathToUrl,
  filenameFromPath,
  inboxItemsSignature,
  isVideoAttachment,
  parseInboxAttachment,
  parseInboxItem,
  parseInboxItems,
} from './inboxController.ts'

describe('inboxController parsing helpers', () => {
  it('parses valid inbox attachments and rejects malformed ones', () => {
    expect(parseInboxAttachment({
      kind: 'image',
      path: '/tmp/a b.png',
      mimeType: 'image/png',
      label: 'preview',
    })).toEqual({
      kind: 'image',
      path: '/tmp/a b.png',
      mimeType: 'image/png',
      label: 'preview',
    })
    expect(parseInboxAttachment({ kind: 'video', path: '/tmp/a.mp4' })).toBeNull()
    expect(parseInboxAttachment({ kind: 'file', path: '' })).toBeNull()
  })

  it('parses inbox items and filters bad attachments', () => {
    const item = parseInboxItem({
      id: 'msg-1',
      createdAt: '2026-05-01T00:00:00.000Z',
      subject: '完成了',
      body: '正文',
      attachments: [
        { kind: 'image', path: '/tmp/a.png' },
        { kind: 'file', path: '' },
      ],
    })

    expect(item).toEqual({
      id: 'msg-1',
      createdAt: '2026-05-01T00:00:00.000Z',
      subject: '完成了',
      body: '正文',
      attachments: [{ kind: 'image', path: '/tmp/a.png' }],
    })
    expect(parseInboxItems([{ id: 1 }, item])).toEqual([item])
  })

  it('detects video attachments by MIME type or file extension', () => {
    expect(isVideoAttachment({ kind: 'file', path: '/tmp/a.bin', mimeType: 'video/mp4' })).toBe(true)
    expect(isVideoAttachment({ kind: 'file', path: '/tmp/a.webm' })).toBe(true)
    expect(isVideoAttachment({ kind: 'file', path: '/tmp/a.pdf' })).toBe(false)
  })

  it('builds stable signatures and path labels', () => {
    const items = parseInboxItems([
      {
        id: 'msg-1',
        createdAt: 't',
        subject: 's',
        body: 'b',
        attachments: [{ kind: 'file', path: '/tmp/a.mov', label: 'clip' }],
      },
    ])
    expect(inboxItemsSignature(items)).toBe(inboxItemsSignature(items))
    expect(inboxItemsSignature(items)).toContain('msg-1')
    expect(filenameFromPath('/tmp/a.mov')).toBe('a.mov')
    expect(filenameFromPath('C:\\tmp\\a.mov')).toBe('a.mov')
    expect(filePathToUrl('/tmp/a b.png')).toBe('file:///tmp/a%20b.png')
    expect(filePathToUrl('https://example.com/a.png')).toBe('https://example.com/a.png')
  })
})
