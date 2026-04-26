import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { localInboxDir } from '../paths.js'

export type InboxAttachment = {
  kind: 'image' | 'file'
  path: string
  mimeType?: string
  label?: string
}

export type InboxMessage = {
  version: 1
  id: string
  createdAt: string
  read: boolean
  subject: string
  body: string
  attachments: InboxAttachment[]
  meta?: Record<string, unknown>
}

export type InboxMessageInput = {
  id?: string
  subject: string
  body: string
  attachments?: InboxAttachment[]
  meta?: Record<string, unknown>
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 120)
}

function messageJsonPath(cwd: string, id: string): string {
  return join(localInboxDir(cwd), `${sanitizeId(id)}.json`)
}

function messageMarkdownPath(cwd: string, id: string): string {
  return join(localInboxDir(cwd), `${sanitizeId(id)}.md`)
}

function renderMarkdown(message: InboxMessage): string {
  const attachments = message.attachments
    .map((a) => {
      if (a.kind === 'image') {
        return `![${a.label ?? 'image'}](${a.path})`
      }
      return `- ${a.label ?? 'file'}: ${a.path}`
    })
    .join('\n\n')

  return [
    `# ${message.subject}`,
    '',
    `- id: ${message.id}`,
    `- created_at: ${message.createdAt}`,
    `- read: ${message.read ? 'true' : 'false'}`,
    '',
    message.body.trim(),
    attachments ? `\n## Attachments\n\n${attachments}` : '',
    '',
  ].join('\n')
}

export function inboxMessageJsonPath(cwd: string, id: string): string {
  return messageJsonPath(cwd, id)
}

export function inboxMessageMarkdownPath(cwd: string, id: string): string {
  return messageMarkdownPath(cwd, id)
}

export async function writeInboxMessage(cwd: string, input: InboxMessageInput): Promise<InboxMessage> {
  const dir = localInboxDir(cwd)
  await mkdir(dir, { recursive: true })
  const createdAt = new Date().toISOString()
  const id = input.id?.trim() || `msg_${createdAt.replace(/[:.]/g, '-')}`
  const message: InboxMessage = {
    version: 1,
    id,
    createdAt,
    read: false,
    subject: input.subject.trim() || '新消息',
    body: input.body.trim(),
    attachments: input.attachments ?? [],
    ...(input.meta ? { meta: input.meta } : {}),
  }
  await writeFile(messageJsonPath(cwd, id), JSON.stringify(message, null, 2) + '\n', 'utf8')
  await writeFile(messageMarkdownPath(cwd, id), renderMarkdown(message), 'utf8')
  return message
}

export async function readInboxMessage(cwd: string, id: string): Promise<InboxMessage | null> {
  try {
    const parsed = JSON.parse(await readFile(messageJsonPath(cwd, id), 'utf8')) as InboxMessage
    if (parsed?.version !== 1) return null
    return parsed
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return null
    throw e
  }
}

export async function markInboxMessageRead(cwd: string, id: string): Promise<InboxMessage | null> {
  const message = await readInboxMessage(cwd, id)
  if (!message) return null
  if (!message.read) {
    message.read = true
    await writeFile(messageJsonPath(cwd, id), JSON.stringify(message, null, 2) + '\n', 'utf8')
    await writeFile(messageMarkdownPath(cwd, id), renderMarkdown(message), 'utf8')
  }
  return message
}

export async function listInboxMessages(cwd: string, opts: { unreadOnly?: boolean; limit?: number } = {}): Promise<InboxMessage[]> {
  const dir = localInboxDir(cwd)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return []
    throw e
  }
  const out: InboxMessage[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), 'utf8')) as InboxMessage
      if (parsed?.version !== 1) continue
      if (opts.unreadOnly && parsed.read) continue
      out.push(parsed)
    } catch {
      /* ignore malformed local inbox files */
    }
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return typeof opts.limit === 'number' ? out.slice(0, Math.max(0, opts.limit)) : out
}
