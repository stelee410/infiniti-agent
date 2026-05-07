import { sendSocketMessage, type SocketLike } from './socketMessages.ts'

export type H5AppletLaunchMode = 'live_panel' | 'floating' | 'fullscreen' | 'overlay'

export type H5AppletCreateData = {
  appId: string
  title: string
  description: string
  launchMode: H5AppletLaunchMode
  html: string
}

export type H5AppletUpdateData = {
  appId: string
  patchType: 'replace' | 'css' | 'state'
  content: string
}

export type H5AppletLibraryItem = {
  id: string
  key: string
  title: string
  description: string
  launchMode: H5AppletLaunchMode
  updatedAt: string
}

type MountedApplet = {
  appId: string
  shell: HTMLElement
  frameShell: HTMLElement
  iframe: HTMLIFrameElement
  resizeObserver: ResizeObserver | null
}

export function createH5AppletHost(opts: {
  root: HTMLElement
  socket: SocketLike
  onInteractiveNeeded?: () => void
  onOpenChange?: (open: boolean) => void
  /**
   * 在向服务端发出 `H5_APPLET_LAUNCH_REQUEST` 之前同步触发；
   * 图标点击与外部 `launch(key)` 调用共用同一路径，确保两条入口的副作用完全一致。
   * 例如用于在压缩/重排发生前记录"快应用打开前的窗口尺寸"。
   */
  onBeforeLaunch?: (key: string) => void
}): {
  launch(key: string): void
  create(data: H5AppletCreateData): void
  update(data: H5AppletUpdateData): void
  destroy(appId: string): void
  setLibrary(items: H5AppletLibraryItem[]): void
  setGenerationStatus(data: { status: 'started' | 'completed' | 'failed'; title: string; key?: string; error?: string }): void
  destroyAll(): void
} {
  const mounted = new Map<string, MountedApplet>()
  let libraryItems: H5AppletLibraryItem[] = []
  let generationText = ''
  let resizeObserver: ResizeObserver | null = null

  const launch = (key: string): void => {
    const normalized = key.trim()
    if (!normalized) return
    opts.onBeforeLaunch?.(normalized)
    sendSocketMessage(opts.socket, 'H5_APPLET_LAUNCH_REQUEST', { key: normalized })
  }

  const launcher = document.createElement('div')
  launcher.className = 'liveui-h5-launcher liveui-h5-launcher--empty'
  opts.root.before(launcher)

  const renderLauncher = (): void => {
    launcher.replaceChildren()
    if (generationText) {
      const status = document.createElement('div')
      status.className = 'liveui-h5-launcher-status'
      status.textContent = generationText
      launcher.append(status)
    }
    for (const item of libraryItems.slice(0, 8)) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'liveui-h5-launcher-btn'
      btn.title = item.description ? `${item.title} - ${item.description}` : item.title
      btn.setAttribute('aria-label', `启动 ${item.title}`)
      const icon = document.createElement('span')
      icon.className = 'liveui-h5-launcher-icon'
      icon.textContent = item.title.trim().slice(0, 1) || '快'
      const label = document.createElement('span')
      label.className = 'liveui-h5-launcher-label'
      label.textContent = item.title
      btn.append(icon, label)
      btn.addEventListener('click', () => launch(item.key))
      launcher.append(btn)
    }
    launcher.classList.toggle('liveui-h5-launcher--empty', !generationText && libraryItems.length === 0)
  }

  const updateBottomReserve = (): void => {
    const dock = document.getElementById('liveui-bottom-dock')
    const rect = dock?.getBoundingClientRect()
    const reserve = rect
      ? Math.max(92, Math.ceil(window.innerHeight - rect.top + 14))
      : 132
    opts.root.style.setProperty('--liveui-h5-bottom-reserve', `${reserve}px`)
    launcher.style.setProperty('--liveui-h5-bottom-reserve', `${reserve}px`)
  }

  updateBottomReserve()
  window.addEventListener('resize', updateBottomReserve)
  if (typeof ResizeObserver !== 'undefined') {
    const dock = document.getElementById('liveui-bottom-dock')
    if (dock) {
      resizeObserver = new ResizeObserver(updateBottomReserve)
      resizeObserver.observe(dock)
    }
  }

  const remove = (appId: string): void => {
    const current = mounted.get(appId)
    if (!current) return
    current.resizeObserver?.disconnect()
    current.shell.remove()
    mounted.delete(appId)
    opts.root.classList.toggle('liveui-h5-runtime--empty', mounted.size === 0)
    if (mounted.size === 0) opts.onOpenChange?.(false)
  }

  const updateFrameFit = (applet: Pick<MountedApplet, 'frameShell' | 'iframe'>): void => {
    const rect = applet.frameShell.getBoundingClientRect()
    const availableWidth = Math.max(1, rect.width)
    const availableHeight = Math.max(1, rect.height)
    const virtualWidth = Math.max(availableWidth, 1280)
    const virtualHeight = Math.max(availableHeight, 768)
    const scale = Math.min(1, availableWidth / virtualWidth, availableHeight / virtualHeight)
    applet.iframe.style.setProperty('--liveui-h5-virtual-width', `${virtualWidth}px`)
    applet.iframe.style.setProperty('--liveui-h5-virtual-height', `${virtualHeight}px`)
    applet.iframe.style.setProperty('--liveui-h5-frame-scale', String(scale))
  }

  const create = (data: H5AppletCreateData): void => {
    opts.onInteractiveNeeded?.()
    remove(data.appId)
    const shell = document.createElement('section')
    shell.className = `liveui-h5-applet liveui-h5-applet--${data.launchMode}`
    shell.dataset.appId = data.appId

    const head = document.createElement('header')
    head.className = 'liveui-h5-applet-head'

    const title = document.createElement('div')
    title.className = 'liveui-h5-applet-title'
    title.textContent = data.title || 'H5 Applet'

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'liveui-h5-applet-close'
    close.title = '关闭 Applet'
    close.setAttribute('aria-label', '关闭 Applet')
    close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.3 5.71 12 12l6.3 6.29-1.41 1.41L10.59 13.41 4.29 19.7 2.88 18.29 9.17 12 2.88 5.71 4.29 4.3l6.3 6.29 6.3-6.29 1.41 1.41z"/></svg>'
    close.addEventListener('pointerdown', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
    })
    close.addEventListener('click', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      remove(data.appId)
      sendSocketMessage(opts.socket, 'H5_APPLET_CLOSE_REQUEST', { appId: data.appId })
    })

    const iframe = document.createElement('iframe')
    iframe.className = 'liveui-h5-applet-frame'
    iframe.title = data.title || 'H5 Applet'
    iframe.sandbox.add('allow-scripts')
    iframe.referrerPolicy = 'no-referrer'
    iframe.srcdoc = data.html

    const frameShell = document.createElement('div')
    frameShell.className = 'liveui-h5-applet-frame-shell'
    frameShell.append(iframe)

    head.append(title, close)
    shell.append(head, frameShell)
    opts.root.append(shell)
    const applet: MountedApplet = {
      appId: data.appId,
      shell,
      frameShell,
      iframe,
      resizeObserver: null,
    }
    mounted.set(data.appId, applet)
    opts.onOpenChange?.(true)
    updateFrameFit(applet)
    if (typeof ResizeObserver !== 'undefined') {
      applet.resizeObserver = new ResizeObserver(() => updateFrameFit(applet))
      applet.resizeObserver.observe(frameShell)
    }
    opts.root.classList.remove('liveui-h5-runtime--empty')
  }

  const update = (data: H5AppletUpdateData): void => {
    const current = mounted.get(data.appId)
    if (!current) return
    if (data.patchType === 'replace') {
      current.iframe.srcdoc = data.content
      return
    }
    current.iframe.contentWindow?.postMessage({
      type: 'HOT_PATCH',
      patchType: data.patchType,
      content: data.content,
    }, '*')
  }

  const onMessage = (ev: MessageEvent): void => {
    const source = [...mounted.values()].find((m) => m.iframe.contentWindow === ev.source)
    if (!source) return
    const msg = ev.data
    if (!msg || typeof msg !== 'object') return
    const raw = msg as Record<string, unknown>
    if (raw.type !== 'APP_EVENT') return
    const event = typeof raw.event === 'string' && raw.event.trim()
      ? raw.event.trim()
      : 'app_event'
    sendSocketMessage(opts.socket, 'H5_APPLET_EVENT', {
      appId: source.appId,
      event,
      payload: raw.payload,
    })
  }

  window.addEventListener('message', onMessage)

  return {
    launch,
    create,
    update,
    destroy: remove,
    setLibrary: (items) => {
      libraryItems = items
      renderLauncher()
    },
    setGenerationStatus: (data) => {
      if (data.status === 'started') {
        generationText = `正在编写：${data.title}`
      } else if (data.status === 'completed') {
        generationText = `已完成：${data.title}`
        setTimeout(() => {
          if (generationText === `已完成：${data.title}`) {
            generationText = ''
            renderLauncher()
          }
        }, 5000)
      } else {
        generationText = `生成失败：${data.title}`
        if (data.error) console.warn('[liveui] H5 applet generation failed:', data.error)
      }
      renderLauncher()
    },
    destroyAll: () => {
      for (const appId of [...mounted.keys()]) remove(appId)
      window.removeEventListener('message', onMessage)
      window.removeEventListener('resize', updateBottomReserve)
      resizeObserver?.disconnect()
      launcher.remove()
    },
  }
}
