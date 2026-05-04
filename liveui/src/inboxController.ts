import { sendSocketMessage, type SocketLike } from './socketMessages.ts'

export type InboxAttachment = {
  kind?: unknown
  path?: unknown
  mimeType?: unknown
  label?: unknown
}

export type InboxItem = {
  id?: unknown
  createdAt?: unknown
  subject?: unknown
  body?: unknown
  attachments?: unknown
}

export type RenderInboxAttachment = { kind: 'image' | 'file'; path: string; mimeType?: string; label?: string }

export type RenderInboxItem = {
  id: string
  createdAt: string
  subject: string
  body: string
  attachments: RenderInboxAttachment[]
}

export type LiveInboxController = {
  readonly isOpen: boolean
  setUnreadRaw(raw: unknown): void
  openRaw(raw: unknown): void
  render(): void
}

type LiveInboxControllerOptions = {
  root: HTMLElement | null
  toggle: HTMLButtonElement | null
  panel: HTMLElement | null
  socket: SocketLike
  positionAtComposer(): void
  setInboxOpen(open: boolean): void
  savePath(request: { defaultPath: string }): Promise<string | undefined> | string | undefined
  getPort(): string
}

const INBOX_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2Zm0 4.2-8 5-8-5V6l8 5 8-5v2.2Z"/></svg>'
const CLOSE_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.3 5.71 12 12l6.3 6.29-1.41 1.41L10.59 13.41 4.29 19.7 2.88 18.29 9.17 12 2.88 5.71 4.29 4.3l6.3 6.29 6.3-6.29 1.41 1.41z"/></svg>'

export function parseInboxAttachment(raw: InboxAttachment): RenderInboxAttachment | null {
  if (!raw || typeof raw !== 'object') return null
  if (raw.kind !== 'image' && raw.kind !== 'file') return null
  if (typeof raw.path !== 'string' || !raw.path.trim()) return null
  const out: RenderInboxAttachment = { kind: raw.kind, path: raw.path }
  if (typeof raw.mimeType === 'string') out.mimeType = raw.mimeType
  if (typeof raw.label === 'string') out.label = raw.label
  return out
}

export function parseInboxItem(raw: InboxItem): RenderInboxItem | null {
  if (!raw || typeof raw !== 'object') return null
  if (
    typeof raw.id !== 'string' ||
    typeof raw.createdAt !== 'string' ||
    typeof raw.subject !== 'string' ||
    typeof raw.body !== 'string' ||
    !Array.isArray(raw.attachments)
  ) {
    return null
  }
  return {
    id: raw.id,
    createdAt: raw.createdAt,
    subject: raw.subject,
    body: raw.body,
    attachments: raw.attachments
      .map((a) => parseInboxAttachment(a as InboxAttachment))
      .filter((a): a is RenderInboxAttachment => a != null),
  }
}

export function parseInboxItems(raw: unknown): RenderInboxItem[] {
  return Array.isArray(raw)
    ? raw.map((it) => parseInboxItem(it as InboxItem)).filter((it): it is RenderInboxItem => it != null)
    : []
}

export function isVideoAttachment(attachment: RenderInboxAttachment): boolean {
  const mt = attachment.mimeType?.toLowerCase() ?? ''
  if (mt.startsWith('video/')) return true
  return /\.(mp4|webm|mov|m4v)$/i.test(attachment.path)
}

export function inboxItemsSignature(items: RenderInboxItem[]): string {
  return items
    .map((item) => {
      const attachments = item.attachments
        .map((attachment) => [
          attachment.kind,
          attachment.path,
          attachment.mimeType ?? '',
          attachment.label ?? '',
        ].join('\u001f'))
        .join('\u001e')
      return [item.id, item.createdAt, item.subject, item.body, attachments].join('\u001d')
    })
    .join('\u001c')
}

export function filePathToUrl(p: string): string {
  if (/^file:/i.test(p) || /^https?:/i.test(p) || /^data:/i.test(p)) return p
  return `file://${p.split('/').map((part) => encodeURIComponent(part)).join('/')}`
}

export function filenameFromPath(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || 'attachment'
}

export function createLiveInboxController(options: LiveInboxControllerOptions): LiveInboxController {
  let unreadInboxItems: RenderInboxItem[] = []
  let openInboxItems: RenderInboxItem[] = []
  let inboxPanelOpen = false
  let inboxRenderSignature = ''
  let inboxMarkTimer: number | undefined

  const filePathToMediaUrl = (p: string): string => {
    if (/^https?:/i.test(p) || /^data:/i.test(p)) return p
    return `http://127.0.0.1:${encodeURIComponent(options.getPort())}/media?path=${encodeURIComponent(p)}`
  }

  const hydrateInboxVideo = async (video: HTMLVideoElement, attachment: RenderInboxAttachment): Promise<void> => {
    video.src = filePathToMediaUrl(attachment.path)
    video.load()
  }

  const appendInboxSaveAction = (wrap: HTMLElement, attachment: RenderInboxAttachment): void => {
    const actions = document.createElement('div')
    actions.className = 'liveui-inbox-actions'
    const saveBtn = document.createElement('button')
    saveBtn.type = 'button'
    saveBtn.className = 'liveui-inbox-action'
    saveBtn.title = '另存为'
    saveBtn.setAttribute('aria-label', '另存为')
    saveBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M5 20h14v-2H5v2ZM19 9h-4V3H9v6H5l7 7 7-7Z"/></svg>'
    saveBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation()
      const defaultPath = attachment.path.split(/[\\/]/).pop() || filenameFromPath(attachment.path)
      const dest = await options.savePath({ defaultPath })
      if (dest) {
        sendSocketMessage(options.socket, 'INBOX_SAVE_AS', {
          sourcePath: attachment.path,
          destinationPath: dest,
        })
      }
    })
    actions.appendChild(saveBtn)
    wrap.appendChild(actions)
  }

  const markVisibleInboxReadSoon = (): void => {
    if (inboxMarkTimer) window.clearTimeout(inboxMarkTimer)
    const ids = unreadInboxItems.map((m) => m.id)
    if (ids.length === 0) return
    inboxMarkTimer = window.setTimeout(() => {
      sendSocketMessage(options.socket, 'INBOX_MARK_READ', { ids })
    }, 1500)
  }

  const render = (): void => {
    if (!options.root || !options.panel) return
    if (!inboxPanelOpen) options.positionAtComposer()
    const items = inboxPanelOpen ? openInboxItems : unreadInboxItems
    const visible = inboxPanelOpen || unreadInboxItems.length > 0
    options.root.classList.toggle('liveui-inbox--visible', visible)
    options.root.classList.toggle('liveui-inbox--open', inboxPanelOpen)
    options.root.setAttribute('aria-hidden', visible ? 'false' : 'true')
    const nextSignature = [
      visible ? 'visible' : 'hidden',
      inboxPanelOpen ? 'open' : 'closed',
      inboxItemsSignature(items),
    ].join('\u001b')
    if (nextSignature === inboxRenderSignature) return
    inboxRenderSignature = nextSignature
    options.panel.replaceChildren()
    if (!visible || items.length === 0) return
    for (const item of items) {
      options.panel.appendChild(renderInboxItem(item, appendInboxSaveAction, hydrateInboxVideo))
    }
  }

  const setOpen = (open: boolean, preferOpenItems = false): void => {
    if (!options.root || !options.toggle) return
    if (open && unreadInboxItems.length === 0 && openInboxItems.length === 0) return
    inboxPanelOpen = open
    if (open) {
      openInboxItems = !preferOpenItems && unreadInboxItems.length > 0 ? [...unreadInboxItems] : [...openInboxItems]
    } else {
      openInboxItems = []
      if (inboxMarkTimer) {
        window.clearTimeout(inboxMarkTimer)
        inboxMarkTimer = undefined
      }
    }
    document.body.classList.toggle('liveui-inbox-open', open)
    options.toggle.innerHTML = open ? CLOSE_ICON_SVG : INBOX_ICON_SVG
    options.toggle.title = open ? '关闭你的邮箱' : '你的邮箱'
    options.toggle.setAttribute('aria-label', open ? '关闭你的邮箱' : '你的邮箱')
    options.setInboxOpen(open)
    render()
    if (open) markVisibleInboxReadSoon()
  }

  options.toggle?.addEventListener('click', () => {
    setOpen(!inboxPanelOpen)
  })

  return {
    get isOpen() {
      return inboxPanelOpen
    },
    setUnreadRaw(raw: unknown) {
      unreadInboxItems = parseInboxItems(raw)
      render()
    },
    openRaw(raw: unknown) {
      openInboxItems = parseInboxItems(raw)
      setOpen(openInboxItems.length > 0, true)
    },
    render,
  }
}

function renderInboxItem(
  item: RenderInboxItem,
  appendInboxSaveAction: (wrap: HTMLElement, attachment: RenderInboxAttachment) => void,
  hydrateInboxVideo: (video: HTMLVideoElement, attachment: RenderInboxAttachment) => Promise<void>,
): HTMLElement {
  const mail = document.createElement('section')
  mail.className = 'liveui-inbox-mail'

  const subject = document.createElement('div')
  subject.className = 'liveui-inbox-subject'
  subject.textContent = item.subject
  mail.appendChild(subject)

  const time = document.createElement('div')
  time.className = 'liveui-inbox-time'
  time.textContent = new Date(item.createdAt).toLocaleString()
  mail.appendChild(time)

  const body = document.createElement('div')
  body.className = 'liveui-inbox-body'
  body.textContent = item.body
  mail.appendChild(body)

  for (const attachment of item.attachments) {
    if (attachment.kind === 'image') {
      const wrap = document.createElement('div')
      wrap.className = 'liveui-inbox-media-wrap'
      const img = document.createElement('img')
      img.className = 'liveui-inbox-image'
      img.alt = attachment.label ?? 'generated image'
      img.src = filePathToUrl(attachment.path)
      wrap.appendChild(img)
      appendInboxSaveAction(wrap, attachment)
      mail.appendChild(wrap)
    } else if (isVideoAttachment(attachment)) {
      const wrap = document.createElement('div')
      wrap.className = 'liveui-inbox-media-wrap'
      const video = document.createElement('video')
      video.className = 'liveui-inbox-video'
      video.controls = true
      video.preload = 'metadata'
      video.playsInline = true
      video.title = attachment.label ?? filenameFromPath(attachment.path)
      video.addEventListener('loadedmetadata', () => {
        console.debug(`[liveui] inbox video metadata loaded: ${attachment.path}`)
      }, { once: true })
      video.addEventListener('error', () => {
        console.warn(`[liveui] inbox video load error: ${attachment.path}`)
        wrap.classList.add('liveui-inbox-media-wrap--error')
      }, { once: true })
      wrap.appendChild(video)
      const hint = document.createElement('div')
      hint.className = 'liveui-inbox-media-hint'
      hint.textContent = filenameFromPath(attachment.path)
      wrap.appendChild(hint)
      void hydrateInboxVideo(video, attachment)
      appendInboxSaveAction(wrap, attachment)
      mail.appendChild(wrap)
    }
  }

  return mail
}
