/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const util = require('util')

const liveUiLogFile =
  process.env.INFINITI_LIVEUI_LOG_FILE ||
  path.join(os.homedir(), '.infiniti-agent', 'logs', 'liveui-electron.log')

function formatLogArg(arg) {
  if (arg instanceof Error) return arg.stack || arg.message
  if (typeof arg === 'string') return arg
  return util.inspect(arg, { depth: 6, breakLength: 180, colors: false })
}

function appendLogLine(level, args) {
  try {
    fs.mkdirSync(path.dirname(liveUiLogFile), { recursive: true })
    const msg = args.map(formatLogArg).join(' ')
    fs.appendFileSync(liveUiLogFile, `${new Date().toISOString()} [${level}] ${msg}\n`, 'utf8')
  } catch {
    /* logging must never break LiveUI */
  }
}

for (const level of ['debug', 'info', 'warn', 'error']) {
  const original = console[level].bind(console)
  console[level] = (...args) => {
    original(...args)
    appendLogLine(level, args)
  }
}

console.error(`[liveui] log file: ${liveUiLogFile}`)

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
  let preConfigBounds = null
  let preCameraBounds = null

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

  win.webContents.session.setPermissionCheckHandler((_webContents, permission) => {
    const ok = permission === 'media' || permission === 'geolocation'
    console.error(`[liveui] permission-check ${permission}: ${ok ? 'allow' : 'deny'}`)
    return ok
  })

  win.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    console.error(`[liveui] permission-request ${permission}`)
    if (permission === 'media' || permission === 'geolocation') {
      callback(true)
      return
    }
    callback(false)
  })

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
      if (preConfigBounds) return
      const h = payload && Number.isFinite(payload.height) ? Math.round(payload.height) : 0
      if (h <= 0) return
      const [, curH] = win.getSize()
      const nextH = Math.max(360, Math.min(1000, h))
      if (nextH === curH) return
      win.setSize(win.getSize()[0], nextH)
    } catch { /* window may be destroyed */ }
  })

  ipcMain.on('liveui-config-panel-open', (_e, open) => {
    try {
      if (open) {
        if (!preConfigBounds) preConfigBounds = win.getBounds()
        win.setIgnoreMouseEvents(false)
        win.setSize(debugWindow ? 760 : 860, debugWindow ? 780 : 720)
        win.center()
      } else if (preConfigBounds) {
        win.setBounds(preConfigBounds)
        preConfigBounds = null
        if (!debugWindow) win.setIgnoreMouseEvents(true, { forward: true })
      }
    } catch { /* window may be destroyed */ }
  })

  ipcMain.on('liveui-camera-capture-open', (_e, open) => {
    try {
      if (open) {
        if (!preCameraBounds) preCameraBounds = win.getBounds()
        win.setIgnoreMouseEvents(false)
        const display = require('electron').screen.getDisplayMatching(win.getBounds())
        win.setBounds(display.workArea)
      } else if (preCameraBounds) {
        win.setBounds(preCameraBounds)
        preCameraBounds = null
        if (!debugWindow) win.setIgnoreMouseEvents(true, { forward: true })
      }
    } catch { /* window may be destroyed */ }
  })

  ipcMain.handle('liveui-get-window-bounds', () => {
    try {
      return win.getBounds()
    } catch {
      return null
    }
  })

  ipcMain.on('liveui-set-window-position', (_e, payload) => {
    try {
      const x = payload && Number.isFinite(payload.x) ? Math.round(payload.x) : null
      const y = payload && Number.isFinite(payload.y) ? Math.round(payload.y) : null
      if (x === null || y === null) return
      win.setPosition(x, y, false)
    } catch { /* window may be destroyed */ }
  })

  ipcMain.handle('liveui-select-path', async (_e, payload) => {
    const kind = payload && payload.kind === 'directory' ? 'directory' : 'file'
    const defaultPath =
      payload && typeof payload.defaultPath === 'string' && payload.defaultPath.trim()
        ? payload.defaultPath.trim()
        : undefined
    const result = await dialog.showOpenDialog(win, {
      title: kind === 'directory' ? '选择目录' : '选择文件',
      ...(defaultPath ? { defaultPath } : {}),
      properties: kind === 'directory' ? ['openDirectory'] : ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0] || null
  })

  ipcMain.handle('liveui-select-attachments', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择附件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '支持的附件',
          extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'md', 'markdown', 'docx', 'csv'],
        },
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
        { name: '文档', extensions: ['pdf', 'md', 'markdown', 'docx', 'csv'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return []
    return result.filePaths
  })

  ipcMain.handle('liveui-save-path', async (_e, payload) => {
    const defaultPath =
      payload && typeof payload.defaultPath === 'string' && payload.defaultPath.trim()
        ? payload.defaultPath.trim()
        : undefined
    const result = await dialog.showSaveDialog(win, {
      title: '另存图片',
      ...(defaultPath ? { defaultPath } : {}),
    })
    if (result.canceled || !result.filePath) return null
    return result.filePath
  })

  ipcMain.handle('liveui-read-local-file-data-url', async (_e, payload) => {
    const filePath =
      payload && typeof payload.path === 'string' && payload.path.trim()
        ? payload.path.trim()
        : ''
    if (!filePath || !path.isAbsolute(filePath)) {
      throw new Error('invalid local file path')
    }
    const stat = await fs.promises.stat(filePath)
    if (!stat.isFile()) {
      throw new Error('not a regular file')
    }
    const maxBytes = 200 * 1024 * 1024
    if (stat.size > maxBytes) {
      throw new Error(`file too large for inline preview: ${stat.size} bytes`)
    }
    const mimeType =
      payload && typeof payload.mimeType === 'string' && payload.mimeType.trim()
        ? payload.mimeType.trim()
        : 'application/octet-stream'
    const buf = await fs.promises.readFile(filePath)
    return `data:${mimeType};base64,${buf.toString('base64')}`
  })

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const levelName = ['verbose', 'info', 'warning', 'error'][level] ?? String(level)
    const where = sourceId ? ` (${sourceId}:${line})` : ''
    console.error(`[liveui:renderer:${levelName}] ${message}${where}`)
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
