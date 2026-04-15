/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow } = require('electron')
const path = require('path')

function createWindow() {
  const port = process.env.INFINITI_LIVEUI_PORT || '8080'
  const indexHtml = path.join(__dirname, 'dist', 'index.html')

  const preload = path.join(__dirname, 'preload.cjs')

  const win = new BrowserWindow({
    width: 420,
    height: 640,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    hasShadow: false,
    resizable: true,
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload,
    },
  })

  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.loadFile(indexHtml, { query: { port } }).catch((err) => {
    console.error('[liveui] loadFile failed', err)
  })

  // 未使用 setIgnoreMouseEvents(true)：否则顶部 drag 区域无法接收按下事件，窗口无法拖动。
  // 若需恢复「除标题条外整窗鼠标穿透」，需在渲染层做命中测试后再动态 setIgnoreMouseEvents。
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  app.quit()
})
