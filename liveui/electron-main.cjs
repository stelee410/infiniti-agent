/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow } = require('electron')
const path = require('path')

function createWindow() {
  const port = process.env.INFINITI_LIVEUI_PORT || '8080'
  const indexHtml = path.join(__dirname, 'dist', 'index.html')

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
    },
  })

  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.loadFile(indexHtml, { query: { port } }).catch((err) => {
    console.error('[liveui] loadFile failed', err)
  })

  // 透明窗口：鼠标穿透（forward 仍会把移动事件转发给页面，便于将来做命中测试）
  win.setIgnoreMouseEvents(true, { forward: true })
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  app.quit()
})
