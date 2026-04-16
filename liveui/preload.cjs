/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require('electron')

const port = process.env.INFINITI_LIVEUI_PORT || '8080'
const model3FileUrl = process.env.INFINITI_LIVEUI_MODEL3_FILE_URL || ''
const spriteExpressionDirFileUrl = process.env.INFINITI_LIVEUI_SPRITE_EXPRESSION_DIR || ''

/** 与 src/liveui/voiceMicEnv.ts 默认保持一致（preload 不可直接 import TS） */
const voiceMicDefaults = {
  speechRmsThreshold: 0.0195,
  silenceEndMs: 1500,
  suppressInterruptDuringTts: true,
}
let voiceMic = { ...voiceMicDefaults }
try {
  const raw = process.env.INFINITI_LIVEUI_VOICE_MIC
  if (raw) {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      voiceMic = { ...voiceMicDefaults, ...parsed }
    }
  }
} catch {
  voiceMic = { ...voiceMicDefaults }
}

contextBridge.exposeInMainWorld('infinitiLiveUi', {
  port,
  model3FileUrl,
  spriteExpressionDirFileUrl,
  voiceMic,
  /** 动态切换窗口透明区域的鼠标穿透 */
  setIgnoreMouseEvents: (ignore, opts) => {
    ipcRenderer.send('set-ignore-mouse-events', ignore, opts)
  },
})
