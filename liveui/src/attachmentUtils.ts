import { filenameFromPath } from './inboxController.ts'

export type ChatAttachmentKind = 'image' | 'document'

export function attachmentMediaType(path: string): string | null {
  const name = filenameFromPath(path).toLowerCase()
  if (/\.(jpe?g)$/.test(name)) return 'image/jpeg'
  if (/\.png$/.test(name)) return 'image/png'
  if (/\.webp$/.test(name)) return 'image/webp'
  if (/\.gif$/.test(name)) return 'image/gif'
  if (/\.pdf$/.test(name)) return 'application/pdf'
  if (/\.md$|\.markdown$/.test(name)) return 'text/markdown'
  if (/\.csv$/.test(name)) return 'text/csv'
  if (/\.docx$/.test(name)) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  return null
}

export function attachmentKindForMediaType(mediaType: string): ChatAttachmentKind {
  return mediaType.startsWith('image/') ? 'image' : 'document'
}

export function attachmentChipLabel(mediaType: string, fileName: string): string {
  if (mediaType === 'application/pdf') return 'PDF'
  if (fileName.toLowerCase().endsWith('.docx')) return 'DOC'
  return 'TXT'
}

export function shouldReadAttachmentText(mediaType: string): boolean {
  return mediaType === 'text/markdown' || mediaType === 'text/csv'
}
