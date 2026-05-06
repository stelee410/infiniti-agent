/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require('electron')

const port = process.env.INFINITI_LIVEUI_PORT || '8080'
const renderer = process.env.INFINITI_LIVEUI_RENDERER || ''
const model3FileUrl = process.env.INFINITI_LIVEUI_MODEL3_FILE_URL || ''
const spriteExpressionDirFileUrl = process.env.INFINITI_LIVEUI_SPRITE_EXPRESSION_DIR || ''
const avatarFallbackFileUrl = process.env.INFINITI_LIVEUI_AVATAR_FALLBACK_FILE_URL || ''

/** config liveUi.figureZoom 或 `infiniti-agent live --zoom <n>` 注入；未传或非法则保持 1（不缩放） */
let figureZoom = 1
{
  const raw = process.env.INFINITI_LIVEUI_FIGURE_ZOOM
  if (raw) {
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 0.4 && n <= 1.5) figureZoom = n
  }
}

/** 与 src/liveui/voiceMicEnv.ts 默认保持一致（preload 不可直接 import TS） */
const voiceMicDefaults = {
  speechRmsThreshold: 0.0195,
  silenceEndMs: 1500,
  suppressInterruptDuringTts: true,
  mode: 'push_to_talk',
  ttsAutoEnabled: true,
  asrAutoEnabled: false,
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
  renderer,
  model3FileUrl,
  spriteExpressionDirFileUrl,
  avatarFallbackFileUrl,
  voiceMic,
  figureZoom,
  /** 动态切换窗口透明区域的鼠标穿透 */
  setIgnoreMouseEvents: (ignore, opts) => {
    ipcRenderer.send('set-ignore-mouse-events', ignore, opts)
  },
  /** 首帧布局后收紧窗口高度（仅 height） */
  compactWindowHeight: (height) => {
    ipcRenderer.send('liveui-compact-height', { height })
  },
  setConfigPanelOpen: (open) => {
    ipcRenderer.send('liveui-config-panel-open', !!open)
  },
  setInboxOpen: (open) => {
    ipcRenderer.send('liveui-inbox-open', !!open)
  },
  setCameraCaptureOpen: (open) => {
    ipcRenderer.send('liveui-camera-capture-open', !!open)
  },
  setMinimalModeOpen: (open, bounds) => {
    ipcRenderer.send('liveui-minimal-mode-open', { open: !!open, ...(bounds || {}) })
  },
  getWindowBounds: () => ipcRenderer.invoke('liveui-get-window-bounds'),
  setWindowPosition: (x, y) => {
    ipcRenderer.send('liveui-set-window-position', { x, y })
  },
  selectPath: (opts) => {
    const kind = opts && opts.kind === 'directory' ? 'directory' : 'file'
    const defaultPath = opts && typeof opts.defaultPath === 'string' ? opts.defaultPath : undefined
    return ipcRenderer.invoke('liveui-select-path', { kind, defaultPath })
  },
  selectAttachments: () => ipcRenderer.invoke('liveui-select-attachments'),
  savePath: (opts) => {
    const defaultPath = opts && typeof opts.defaultPath === 'string' ? opts.defaultPath : undefined
    return ipcRenderer.invoke('liveui-save-path', { defaultPath })
  },
})
