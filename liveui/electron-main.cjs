/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, Menu } = require('electron')
const path = require('path')

/**
 * 无边框透明叠层模式（与早期 LiveUI 一致）：
 *   INFINITI_LIVEUI_FRAMELESS=1
 * 默认：带系统标题栏 + 菜单，便于调试。
 */
const frameless = process.env.INFINITI_LIVEUI_FRAMELESS === '1'

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
    width: frameless ? 420 : 520,
    height: frameless ? 640 : 780,
    frame: !frameless,
    transparent: frameless,
    backgroundColor: frameless ? undefined : '#1a1d24',
    alwaysOnTop: frameless,
    hasShadow: !frameless,
    resizable: true,
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload,
      webSecurity: false,
    },
  })

  if (frameless) {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }

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
  if (!frameless) {
    Menu.setApplicationMenu(buildMenu())
  }
  createWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})
