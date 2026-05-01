import { describe, expect, it } from 'vitest'
import {
  attachmentChipLabel,
  attachmentKindForMediaType,
  attachmentMediaType,
  shouldReadAttachmentText,
} from './attachmentUtils.ts'

describe('attachmentUtils', () => {
  it('detects supported attachment media types from paths', () => {
    expect(attachmentMediaType('/tmp/photo.JPG')).toBe('image/jpeg')
    expect(attachmentMediaType('/tmp/photo.png')).toBe('image/png')
    expect(attachmentMediaType('/tmp/photo.webp')).toBe('image/webp')
    expect(attachmentMediaType('/tmp/photo.gif')).toBe('image/gif')
    expect(attachmentMediaType('/tmp/report.pdf')).toBe('application/pdf')
    expect(attachmentMediaType('/tmp/notes.markdown')).toBe('text/markdown')
    expect(attachmentMediaType('/tmp/data.csv')).toBe('text/csv')
    expect(attachmentMediaType('/tmp/doc.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    expect(attachmentMediaType('/tmp/archive.zip')).toBeNull()
  })

  it('classifies attachment kinds and compact chip labels', () => {
    expect(attachmentKindForMediaType('image/png')).toBe('image')
    expect(attachmentKindForMediaType('application/pdf')).toBe('document')
    expect(attachmentChipLabel('application/pdf', 'x.pdf')).toBe('PDF')
    expect(attachmentChipLabel('application/octet-stream', 'x.docx')).toBe('DOC')
    expect(attachmentChipLabel('text/csv', 'x.csv')).toBe('TXT')
  })

  it('marks text-like attachments that should be read into prompts', () => {
    expect(shouldReadAttachmentText('text/markdown')).toBe(true)
    expect(shouldReadAttachmentText('text/csv')).toBe(true)
    expect(shouldReadAttachmentText('application/pdf')).toBe(false)
  })
})
