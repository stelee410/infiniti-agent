/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, Menu, ipcMain } = require('electron')
const path = require('path')

// LiveUI TTS：Web Audio 在无用户手势时默认 suspended；放宽策略以便首包语音可播。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

/**
 * 默认：无边框、透明、置顶（LiveUI 叠层）。
 * 需要系统标题栏 + 菜单便于调试时：
 *   INFINITI_LIVEUI_DEBUG_WINDOW=1
 */
const debugWindow = process.env.INFINITI_LIVEUI_DEBUG_WINDOW === '1'

function buildMenu() {
  const isMac = process.platform === 'darwin'
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = []

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    })
  } else {
    template.push({
      label: '文件',
      submenu: [{ role: 'quit', label: '退出' }],
    })
  }

  template.push({
    label: '视图',
    submenu: [
      { role: 'reload', label: '重新加载' },
      { role: 'forceReload', label: '强制重新加载' },
      { role: 'toggleDevTools', label: '开发者工具' },
      { type: 'separator' },
      { role: 'resetZoom', label: '实际大小' },
      { role: 'zoomIn', label: '放大' },
      { role: 'zoomOut', label: '缩小' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: '全屏' },
    ],
  })

  return Menu.buildFromTemplate(template)
}

function createWindow() {
  const port = process.env.INFINITI_LIVEUI_PORT || '8080'
  const indexHtml = path.join(__dirname, 'dist', 'index.html')

  const preload = path.join(__dirname, 'preload.cjs')

  const win = new BrowserWindow({
    title: 'Infiniti LiveUI',
    width: debugWindow ? 520 : 420,
    /** 非 debug 略低于 640；人物加载后渲染端还可再收紧一次 */
    height: debugWindow ? 780 : 580,
    frame: debugWindow,
    transparent: !debugWindow,
    backgroundColor: debugWindow ? '#1a1d24' : undefined,
    alwaysOnTop: !debugWindow,
    hasShadow: debugWindow,
    resizable: true,
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload,
      webSecurity: false,
    },
  })

  if (!debugWindow) {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }

  /**
   * macOS 透明窗口默认在透明像素处穿透点击。
   * 用 forward: true 让 mousemove 仍然到达渲染进程，
   * 渲染端检测鼠标是否在人物/控件区域，通过 IPC 动态切换。
   */
  if (!debugWindow) {
    win.setIgnoreMouseEvents(true, { forward: true })
  }

  ipcMain.on('set-ignore-mouse-events', (_e, ignore, opts) => {
    try {
      win.setIgnoreMouseEvents(ignore, opts ?? {})
    } catch { /* window may be destroyed */ }
  })

  /** 仅调高度：由渲染端在首帧布局后请求一次，去掉头顶大块留白（不设复杂循环） */
  ipcMain.on('liveui-compact-height', (_e, payload) => {
    try {
      const h = payload && Number.isFinite(payload.height) ? Math.round(payload.height) : 0
      if (h <= 0) return
      const [, curH] = win.getSize()
      const nextH = Math.max(360, Math.min(1000, h))
      if (nextH === curH) return
      win.setSize(win.getSize()[0], nextH)
    } catch { /* window may be destroyed */ }
  })

  win.loadFile(indexHtml, { query: { port } }).catch((err) => {
    console.error('[liveui] loadFile failed', err)
  })

  if (process.env.INFINITI_LIVEUI_DEVTOOLS === '1') {
    win.webContents.once('did-finish-load', () => {
      win.webContents.openDevTools({ mode: 'detach' })
    })
  }
}

app.whenReady().then(() => {
  if (debugWindow) {
    Menu.setApplicationMenu(buildMenu())
  }
  createWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})
