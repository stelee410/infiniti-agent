/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge } = require('electron')

const port = process.env.INFINITI_LIVEUI_PORT || '8080'
const model3FileUrl = process.env.INFINITI_LIVEUI_MODEL3_FILE_URL || ''

contextBridge.exposeInMainWorld('infinitiLiveUi', {
  port,
  model3FileUrl,
})
