/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require('electron')

const port = process.env.INFINITI_LIVEUI_PORT || '8080'
const model3FileUrl = process.env.INFINITI_LIVEUI_MODEL3_FILE_URL || ''

contextBridge.exposeInMainWorld('infinitiLiveUi', {
  port,
  model3FileUrl,
  /** 动态切换窗口透明区域的鼠标穿透 */
  setIgnoreMouseEvents: (ignore, opts) => {
    ipcRenderer.send('set-ignore-mouse-events', ignore, opts)
  },
})
