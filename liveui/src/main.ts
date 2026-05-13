import * as PIXI from 'pixi.js'
import { Live2DModel, cubism4Ready } from 'pixi-live2d-display/cubism4'
import {
  createStreamLiveUiState,
  processAssistantStreamChunk,
  stripLiveUiKnownEmotionTagsEverywhere,
  type StreamLiveUiState,
} from '../../src/liveui/emotionParse.ts'
import type { LiveUiStatusVariant, LiveUiVisionAttachment } from '../../src/liveui/protocol.ts'
import { renderLiveUiBubbleMarkdown } from './bubbleMarkdown.ts'
import { computeAssistantContentLayoutPlan } from './assistantContentLayoutPolicy.ts'
import { ReconnectingWebSocket } from './reconnectingWebSocket.ts'
import { isSocketOpen, sendSocketMessage } from './socketMessages.ts'
import {
  clampFigureZoom,
  computeFigureLayoutPlan,
  computeFigureScale,
  computeReal2dCompactScaleCompensation,
  computeReal2dRuntimeStageHeight,
  computeReal2dStageHeight,
} from './figureManager.ts'
import {
  createLiveUiLayoutCoordinator,
  type LiveUiLayoutCoordinator,
} from './layoutCoordinator.ts'
import {
  HIT_BODY_RE,
  HIT_HEAD_RE,
  LIVE2D_BODY_POKE_MOTIONS,
  LIVE2D_IDLE,
} from './interactionConfig.ts'
import {
  buildEmotionToSpriteIdFromManifest,
  parseSpriteExpressionManifest,
  type SpriteExpressionManifestV1,
} from '../../src/liveui/spriteExpressionManifestCore.ts'
import { initConfigPanel } from './configPanel.ts'
import {
  createLiveInboxController,
  filePathToUrl,
  filenameFromPath,
} from './inboxController.ts'
import {
  attachmentChipLabel,
  attachmentKindForMediaType,
  attachmentMediaType,
  shouldReadAttachmentText,
} from './attachmentUtils.ts'
import {
  VAD_FFT_SIZE,
  computeVadFrame as computeVadFrameFromSamples,
  resolveVoiceMicWire,
} from './voiceMicUtils.ts'
import {
  PcmS16Coalescer,
  base64ToArrayBuffer,
  normalizePcmAudioMeta,
} from './ttsAudioUtils.ts'
import {
  canNavigateInputHistory as canNavigateHistoryValue,
  navigateInputHistory as navigateHistoryValue,
  parseInputHistory,
  rememberInput,
} from './inputHistory.ts'
import {
  slashInsertText,
  slashMenuHintText,
  slashMenuWindow,
  type SlashRow,
} from './slashMenuModel.ts'
import {
  describeCameraError,
  photoDataUrl,
  scaledCaptureSize,
} from './cameraUtils.ts'
import {
  configPanelLayoutAction,
  isWindowSizeRestored,
  shouldApplyReal2dResizeLayout,
  shouldResetReal2dCompactScaleOnConfigClose,
  shouldRunDynamicFigureFit,
  shouldFreezeReal2dStageLayoutForH5,
  type ConfigPanelCloseReason,
  type WindowSize,
} from './panelLayoutPolicy.ts'
import { adaptExpression, type RendererKind } from './expressionAdapter.ts'
import { Real2dLiveUiAdapter, type Real2dExpressionSlot } from './real2dLiveUiAdapter.ts'
import { createLiveUiWindowManager } from './windowManager.ts'
import { createH5AppletHost } from './h5AppletRuntime.ts'

/** 由 expressions.json 注入，覆盖默认 exp_xx 映射 */
let spriteEmotionToIdOverride: Record<string, string> | null = null
/** 与 sprite 同源 manifest，用于气泡去标签正则 */
let streamManifestForStrip: SpriteExpressionManifestV1 | null = null

declare global {
  interface Window {
    infinitiLiveUi?: {
      port: string
      renderer?: string
      model3FileUrl: string
      /** 含尾斜杠的 `file:` URL，指向含 `exp_01.png`…的目录（与 CLI `spriteExpressions.dir` 一致） */
      spriteExpressionDirFileUrl?: string
      /** spriteExpressions 不可用时展示在控制条左上角的头像 */
      avatarFallbackFileUrl?: string
      voiceMic?: Partial<LiveUiVoiceMicWire>
      /** `infiniti-agent live --zoom <n>` 注入：人物显示缩放（0.4 ~ 1.5），1 = 不缩放 */
      figureZoom?: number
      setIgnoreMouseEvents?: (ignore: boolean, opts?: { forward?: boolean }) => void
      /** Electron：首帧后按人物包围盒收紧窗口高度 */
      compactWindowHeight?: (height: number) => void
      /** Electron：配置面板打开时临时切换到较大的可交互窗口 */
      setConfigPanelOpen?: (open: boolean) => void
      /** Electron：邮箱打开时临时切换到全屏可交互窗口 */
      setInboxOpen?: (open: boolean) => void
      /** Electron：拍照倒计时/闪光时临时铺满屏幕 */
      setCameraCaptureOpen?: (open: boolean) => void
      /** Electron：H5 快应用打开时临时铺满屏幕，供内部 applet 取 80vw/80vh */
      setH5AppletOpen?: (open: boolean) => void
      /** Electron：极简模式时收缩/恢复透明窗口边界 */
      setMinimalModeOpen?: (open: boolean, bounds?: { width: number; height: number }) => void
      /** Electron：读取窗口位置，供自绘拖拽按钮使用 */
      getWindowBounds?: () => Promise<{ x: number; y: number; width: number; height: number } | null>
      /** Electron：移动窗口，供自绘拖拽按钮使用 */
      setWindowPosition?: (x: number, y: number) => void
      /** Electron：选择本地文件或目录 */
      selectPath?: (opts: { kind: 'file' | 'directory'; defaultPath?: string }) => Promise<string | null>
      /** Electron：选择对话附件 */
      selectAttachments?: () => Promise<string[]>
      /** Electron：打开系统另存为对话框 */
      savePath?: (opts: { defaultPath?: string }) => Promise<string | null>
      showMessage?: (opts: {
        type?: 'none' | 'info' | 'error' | 'question' | 'warning'
        title?: string
        message?: string
        detail?: string
        buttons?: string[]
      }) => Promise<{ response: number }>
    }
    ImageCapture?: new (track: MediaStreamTrack) => {
      grabFrame: () => Promise<ImageBitmap>
    }
    /** pixi-live2d-display 依赖全局 PIXI.Ticker */
    PIXI: typeof PIXI
  }
}

type SyncParam = {
  type: 'SYNC_PARAM'
  data: { id: 'ParamMouthOpenY'; value: number }
}

type ActionMsg = {
  type: 'ACTION'
  data: { expression?: string; intensity?: number; motion?: string; gaze?: string }
}

type DebugStateMsg = {
  type: 'DEBUG_STATE'
  data: {
    enabled?: unknown
    emotion?: unknown
    emotionIntensity?: unknown
    relationship?: unknown
  }
}

type AssistantStreamMsg = {
  type: 'ASSISTANT_STREAM'
  data: { fullRaw: string; reset?: boolean; done?: boolean }
}

type StatusPillMsg = {
  type: 'STATUS_PILL'
  data: { label: string; variant: LiveUiStatusVariant }
}

type AudioChunkMsg = {
  type: 'AUDIO_CHUNK'
  data: {
    audioBase64: string
    format: string
    sampleRate: number
    sequence: number
    channels?: number
  }
}

type AudioResetMsg = { type: 'AUDIO_RESET' }

type TtsStatusMsg = { type: 'TTS_STATUS'; data: { available: boolean; enabled?: unknown } }
type AsrStatusMsg = { type: 'ASR_STATUS'; data: { available: boolean } }
type AsrResultMsg = { type: 'ASR_RESULT'; data: { text: string } }
type CallAvailabilityMsg = { type: 'CALL_AVAILABILITY'; data: { asr: boolean; tts: boolean; reasons?: string[] } }

type SlashCompletionMsg = {
  type: 'SLASH_COMPLETION'
  data: { open?: boolean; items?: unknown }
}

type ConfigOpenMsg = {
  type: 'CONFIG_OPEN'
  data: { cwd?: unknown; config?: unknown }
}

type ConfigStatusMsg = {
  type: 'CONFIG_STATUS'
  data: { ok?: unknown; message?: unknown }
}

type VisionCaptureResultMsg = {
  type: 'VISION_CAPTURE_RESULT'
  data: {
    requestId?: unknown
    ok?: unknown
    vision?: unknown
    error?: unknown
  }
}

type InboxUpdateMsg = {
  type: 'INBOX_UPDATE'
  data: { unread?: unknown }
}

type InboxOpenMsg = {
  type: 'INBOX_OPEN'
  data: { items?: unknown }
}

type InboxSaveResultMsg = {
  type: 'INBOX_SAVE_RESULT'
  data: { ok?: unknown; message?: unknown }
}

type H5AppletCreateMsg = {
  type: 'H5_APPLET_CREATE'
  data: {
    appId?: unknown
    title?: unknown
    description?: unknown
    launchMode?: unknown
    html?: unknown
  }
}

type H5AppletUpdateMsg = {
  type: 'H5_APPLET_UPDATE'
  data: {
    appId?: unknown
    patchType?: unknown
    content?: unknown
  }
}

type H5AppletDestroyMsg = {
  type: 'H5_APPLET_DESTROY'
  data: { appId?: unknown }
}

type H5AppletLibraryMsg = {
  type: 'H5_APPLET_LIBRARY'
  data: { items?: unknown }
}

type H5AppletLaunchMsg = {
  type: 'H5_APPLET_LAUNCH'
  data: { key?: unknown }
}

type H5AppletGenerationMsg = {
  type: 'H5_APPLET_GENERATION'
  data: {
    status?: unknown
    title?: unknown
    key?: unknown
    error?: unknown
  }
}

type ChatAttachment = {
  id: string
  name: string
  mediaType: string
  base64: string
  size: number
  kind: 'image' | 'document'
  capturedAt: string
  text?: string
}

type Msg =
  | SyncParam
  | ActionMsg
  | DebugStateMsg
  | AssistantStreamMsg
  | StatusPillMsg
  | AudioChunkMsg
  | AudioResetMsg
  | TtsStatusMsg
  | AsrStatusMsg
  | AsrResultMsg
  | CallAvailabilityMsg
  | SlashCompletionMsg
  | ConfigOpenMsg
  | ConfigStatusMsg
  | VisionCaptureResultMsg
  | InboxUpdateMsg
  | InboxOpenMsg
  | InboxSaveResultMsg
  | H5AppletCreateMsg
  | H5AppletUpdateMsg
  | H5AppletDestroyMsg
  | H5AppletLibraryMsg
  | H5AppletLaunchMsg
  | H5AppletGenerationMsg

const FACE_RADIUS = 110

/** 从 Cubism4 MotionManager.definitions（或 model3 的 motions）收集可随机播放的条目的 group/index。 */
function collectMotionEntriesFromDefinitions(
  defs: Record<string, unknown> | undefined | null,
): { group: string; index: number }[] {
  const out: { group: string; index: number }[] = []
  if (!defs || typeof defs !== 'object') return out
  for (const [group, items] of Object.entries(defs)) {
    if (Array.isArray(items)) {
      for (let i = 0; i < items.length; i++) {
        out.push({ group, index: i })
      }
    } else if (items != null && typeof items === 'object') {
      /* 个别 model3 里某组只有单对象无数组包装 */
      out.push({ group, index: 0 })
    }
  }
  return out
}

function readPort(): string {
  const fromPreload = window.infinitiLiveUi?.port?.trim()
  if (fromPreload) return fromPreload
  return new URLSearchParams(window.location.search).get('port') ?? '8080'
}

function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 将 TUI 情感名映射到 mao_pro 等模型的 expression 名（model3 内 Name 字段） */
function emotionToExpressionId(em: string): string {
  const e = em.toLowerCase().trim()
  if (spriteEmotionToIdOverride?.[e]) return spriteEmotionToIdOverride[e]!
  const map: Record<string, string> = {
    happy: 'exp_03',
    joy: 'exp_03',
    sad: 'exp_02',
    sadness: 'exp_02',
    neutral: 'exp_01',
    calm: 'exp_01',
    thinking: 'exp_05',
    think: 'exp_05',
    angry: 'exp_06',
    anger: 'exp_06',
    surprised: 'exp_07',
    surprise: 'exp_07',
    frown: 'exp_08',
    smirk: 'exp_04',
    disgust: 'exp_04',
    blush: 'exp_04',
    fear: 'exp_02',
  }
  return map[e] ?? 'exp_01'
}

function firstMappedExpressionId(map: Record<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const id = map[key]?.trim()
    if (id) return id
  }
  return undefined
}

function real2dExpressionIdsFromEmotionMap(
  map: Record<string, string> | null,
): Partial<Record<Real2dExpressionSlot, string>> | undefined {
  if (!map) return undefined
  const out: Partial<Record<Real2dExpressionSlot, string>> = {}
  const slots: Array<[Real2dExpressionSlot, string[]]> = [
    ['neutral', ['neutral', 'calm']],
    ['happy', ['happy', 'joy']],
    ['sad', ['sad', 'sadness', 'fear', 'frown', 'unhappy']],
    ['angry', ['angry', 'anger']],
    ['surprised', ['surprised', 'surprise']],
    ['eyes_closed', ['eyes_closed', 'eyesclosed', 'blink', 'closed']],
    ['exp_a', ['exp_a', 'mouth_a', 'viseme_a']],
    ['exp_ee', ['exp_ee', 'mouth_ee', 'viseme_ee']],
    ['exp_o', ['exp_o', 'mouth_o', 'viseme_o']],
    ['exp_open', ['exp_open', 'talk', 'talking', 'speaking']],
  ]
  for (const [slot, keys] of slots) {
    const id = firstMappedExpressionId(map, keys)
    if (id) out[slot] = id
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * 从 model3.json 的 Groups 中提取 LipSync 参数名列表。
 * 不同模型可能用 ParamMouthOpenY / ParamA / 其他名字。
 */
function getLipSyncParamIds(model: InstanceType<typeof Live2DModel>): string[] {
  try {
    const im = model.internalModel as {
      settings?: { groups?: Array<{ Name?: string; Ids?: string[] }> }
    }
    const groups = im?.settings?.groups
    if (groups) {
      const ls = groups.find((g) => g.Name === 'LipSync')
      if (ls?.Ids?.length) return ls.Ids
    }
  } catch { /* fallback */ }
  return ['ParamMouthOpenY']
}

const lipSyncParamCache = new WeakMap<InstanceType<typeof Live2DModel>, string[]>()

function setMouthFromModel(model: InstanceType<typeof Live2DModel>, value01: number): void {
  const im = model.internalModel as { coreModel?: { setParameterValueById?: (id: string, v: number) => void } }
  const core = im?.coreModel
  if (!core || typeof core.setParameterValueById !== 'function') return

  let paramIds = lipSyncParamCache.get(model)
  if (!paramIds) {
    paramIds = getLipSyncParamIds(model)
    lipSyncParamCache.set(model, paramIds)
    console.debug('[liveui] LipSync 参数:', paramIds)
  }

  const v = Math.max(0, Math.min(1, value01))
  for (const id of paramIds) {
    try {
      core.setParameterValueById(id, v)
    } catch { /* 忽略不存在的参数 */ }
  }
}

async function bootstrap(): Promise<void> {
  const canvas = document.getElementById('app') as HTMLCanvasElement | null
  const speechBubble = document.getElementById('speech-bubble')
  const speechBubbleText = document.getElementById(
    'speech-bubble-text',
  ) as HTMLElement | null
  const statusPill = document.getElementById('liveui-status-pill')
  const debugEmotionEl = document.getElementById('liveui-debug-emotion')
  const debugRelationshipEl = document.getElementById('liveui-debug-relationship')
  const userLineInput = document.getElementById('liveui-user-line') as HTMLTextAreaElement | null
  const inboxRoot = document.getElementById('liveui-inbox')
  const h5AppletRoot = document.getElementById('liveui-h5-runtime')
  const inboxToggle = document.getElementById('liveui-inbox-toggle') as HTMLButtonElement | null
  const inboxPanel = document.getElementById('liveui-inbox-panel')
  if (!canvas) return

  window.PIXI = PIXI
  /* 必须传入 Ticker 类；插件内部使用 tickerRef.shared.add（传 Ticker.shared 会 undefined） */
  Live2DModel.registerTicker(PIXI.Ticker)

  const app = new PIXI.Application({
    view: canvas,
    width: window.innerWidth,
    height: window.innerHeight,
    backgroundAlpha: 0,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  })
  const windowManager = createLiveUiWindowManager(window.infinitiLiveUi)

  const face = new PIXI.Graphics()
  face.beginFill(0x6ec5ff, 0.85)
  face.drawCircle(0, 0, FACE_RADIUS)
  face.endFill()
  face.position.set(app.screen.width / 2, app.screen.height / 2 - 20)
  face.interactive = true
  face.cursor = 'pointer'
  face.hitArea = new PIXI.Circle(0, 0, FACE_RADIUS)

  const mouth = new PIXI.Graphics()
  mouth.position.set(face.x, face.y + 38)

  let liveModel: InstanceType<typeof Live2DModel> | null = null
  let real2dAvatar: Real2dLiveUiAdapter | null = null
  /** PNG 表情精灵（`spriteExpressions.dir`）；与 Live2D 二选一，由预加载环境变量决定 */
  let expressionSprite: PIXI.Sprite | null = null
  /** `file:` 基址，含尾斜杠，用于 `new URL('exp_XX.png', base)` */
  let spriteExpressionDirFileUrl = ''
  let spriteNaturalW = 1024
  let spriteNaturalH = 1024
  /** 模型在 scale=1 时的本地包围尺寸，用于缩放计算（勿用 liveModel.width：会含当前 scale，Resize 时会越算越大） */
  let liveModelNaturalW = 400
  let liveModelNaturalH = 600
  let real2dLayoutHeight = 0
  let real2dLayoutWidth = 0
  let real2dStableStageHeight = 0
  let real2dPlacementTimer: ReturnType<typeof window.setTimeout> | null = null
  let pendingReal2dCompactHeight: number | null = null
  let real2dCompactBaseStageHeight: number | null = null
  let configPanelReturnWindowSize: WindowSize | null = null
  let pendingConfigPanelCloseWindowSize: WindowSize | null = null
  let debugOverlayEnabled = false
  let debugEmotion = 'neutral'
  let debugEmotionIntensity = 0

  const formatDebugNumber = (value: unknown): string => {
    const n = typeof value === 'number' && Number.isFinite(value) ? value : 0
    return n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2)
  }

  const renderDebugOverlay = (relationship?: Record<string, unknown>): void => {
    if (!debugEmotionEl || !debugRelationshipEl) return
    debugEmotionEl.hidden = !debugOverlayEnabled
    debugRelationshipEl.hidden = !debugOverlayEnabled
    debugEmotionEl.setAttribute('aria-hidden', String(!debugOverlayEnabled))
    debugRelationshipEl.setAttribute('aria-hidden', String(!debugOverlayEnabled))
    if (!debugOverlayEnabled) return
    debugEmotionEl.textContent = `emotion\n${debugEmotion}\n${debugEmotionIntensity.toFixed(2)}`
    if (relationship) {
      debugRelationshipEl.replaceChildren(
        `trust ${formatDebugNumber(relationship.trust)}`,
        document.createElement('br'),
        `affinity ${formatDebugNumber(relationship.affinity)}`,
        document.createElement('br'),
        `intimacy ${formatDebugNumber(relationship.intimacy)}`,
        document.createElement('br'),
        `respect ${formatDebugNumber(relationship.respect)}`,
        document.createElement('br'),
        `tension ${formatDebugNumber(relationship.tension)}`,
      )
    }
  }

  const real2dStageHeight = (): number => {
    const controlBar = document.getElementById('liveui-control-bar')
    return computeReal2dStageHeight(window.innerHeight, controlBar?.getBoundingClientRect().top)
  }

  const real2dRuntimeStageHeight = (): number => {
    const current = real2dStageHeight()
    const next = computeReal2dRuntimeStageHeight({
      currentStageHeight: current,
      stableStageHeight: real2dStableStageHeight,
      minimalMode,
    })
    real2dStableStageHeight = next.stableStageHeight
    return next.runtimeStageHeight
  }

  const applyReal2dStageLayout = (resizeRuntime = true): void => {
    // 快应用生命周期内绝不改 stage：dock 被 display:none 时 controlBar.top=0，
    // real2dRuntimeStageHeight 会把整窗高度当成 stage 高度，永久推升 stable，
    // 关闭后 avatar canvas 残留为工作区高度（人物视觉被放大）。
    if (shouldFreezeReal2dStageLayoutForH5({
      h5AppletOpen,
      pendingH5AppletCloseWindowSize,
    })) return
    const stage = document.getElementById('liveui-real2d-stage') as HTMLElement | null
    if (!stage) return
    const nextWidth = window.innerWidth
    const nextHeight = real2dRuntimeStageHeight()
    stage.style.left = '0'
    stage.style.right = '0'
    stage.style.top = '0'
    stage.style.bottom = 'auto'
    stage.style.width = '100vw'
    stage.style.height = `${nextHeight}px`
    const changed = nextWidth !== real2dLayoutWidth || nextHeight !== real2dLayoutHeight
    real2dLayoutWidth = nextWidth
    real2dLayoutHeight = nextHeight
    if (resizeRuntime && changed) {
      real2dAvatar?.resize(real2dLayoutWidth, real2dLayoutHeight)
    }
  }

  const resetReal2dCompactScaleState = (): void => {
    pendingReal2dCompactHeight = null
    real2dCompactBaseStageHeight = null
    real2dAvatar?.setStageScaleCompensation(1)
  }

  /**
   * 人物始终站在控制条（输入框）上方；气泡独立浮层，不影响人物位置。
   */
  const layoutFigureInStage = (): void => {
    const W = app.screen.width
    const H = app.screen.height
    const canvasRect = canvas.getBoundingClientRect()
    const dock = document.getElementById('liveui-bottom-dock')
    const controlBar = document.getElementById('liveui-control-bar')
    const plan = computeFigureLayoutPlan({
      viewportWidth: W,
      viewportHeight: H,
      canvasTop: canvasRect.top,
      dockTop: dock?.getBoundingClientRect().top,
      controlBarTop: controlBar?.getBoundingClientRect().top,
      figureZoom: window.infinitiLiveUi?.figureZoom,
    })

    if (liveModel) {
      const s = computeFigureScale(plan, W, liveModelNaturalW, liveModelNaturalH)
      liveModel.scale.set(s, s)
      liveModel.position.set(W / 2, H / 2)
      const b = liveModel.getBounds()
      liveModel.position.y += plan.targetFootY - b.bottom
      liveModel.position.y += plan.footNudgeMax
      const b2 = liveModel.getBounds()
      if (b2.bottom > plan.soleCeiling) {
        liveModel.position.y -= b2.bottom - plan.soleCeiling
      }
    } else if (expressionSprite) {
      const s = computeFigureScale(plan, W, spriteNaturalW, spriteNaturalH)
      expressionSprite.scale.set(s, s)
      expressionSprite.position.set(W / 2, H / 2)
      const b = expressionSprite.getBounds()
      expressionSprite.position.y += plan.targetFootY - b.bottom
      expressionSprite.position.y += plan.footNudgeMax
      const b2 = expressionSprite.getBounds()
      if (b2.bottom > plan.soleCeiling) {
        expressionSprite.position.y -= b2.bottom - plan.soleCeiling
      }
      mouth.position.set(b2.x + b2.width / 2, b2.bottom + 10)
    } else {
      let fy = plan.targetFootY - FACE_RADIUS + plan.footNudgeMax
      if (fy + FACE_RADIUS > plan.soleCeiling) {
        fy = plan.soleCeiling - FACE_RADIUS
      }
      face.position.set(W / 2, fy)
      mouth.position.set(face.x, face.y + 38)
    }
  }

  const scheduleReal2dVerticalPlacement = (attempt = 0): void => {
    if (!real2dAvatar) return
    if (real2dPlacementTimer) {
      window.clearTimeout(real2dPlacementTimer)
      real2dPlacementTimer = null
    }
    real2dPlacementTimer = window.setTimeout(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!real2dAvatar) return
          const b = real2dAvatar.getVisualBounds()
          if (!b) {
            if (attempt < 8) scheduleReal2dVerticalPlacement(attempt + 1)
            return
          }
          const bottomGoal = real2dStageHeight() + 6
          const delta = bottomGoal - b.bottom
          if (Math.abs(delta) <= 2) return
          real2dAvatar.setVerticalOffset(real2dAvatar.getVerticalOffset() + delta)
          window.setTimeout(() => scheduleDynamicWindowFit(), 80)
          if (attempt < 6) {
            scheduleReal2dVerticalPlacement(attempt + 1)
          }
        })
      })
    }, attempt === 0 ? 0 : 120)
  }

  const settleReal2dVerticalPlacement = (attempt = 0): Promise<boolean> =>
    new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!real2dAvatar) {
            resolve(false)
            return
          }
          const b = real2dAvatar.getVisualBounds()
          if (!b) {
            if (attempt < 8) {
              window.setTimeout(() => {
                void settleReal2dVerticalPlacement(attempt + 1).then(resolve)
              }, 120)
              return
            }
            resolve(false)
            return
          }
          const bottomGoal = real2dStageHeight() + 6
          const delta = bottomGoal - b.bottom
          if (Math.abs(delta) <= 2 || attempt >= 6) {
            resolve(true)
            return
          }
          real2dAvatar.setVerticalOffset(real2dAvatar.getVerticalOffset() + delta)
          window.setTimeout(() => {
            void settleReal2dVerticalPlacement(attempt + 1).then(resolve)
          }, 80)
        })
      })
    })

  let configPanelOpen = false
  let inboxOpen = false
  let inboxReturnWindowSize: WindowSize | null = null
  let pendingInboxCloseWindowSize: WindowSize | null = null
  let cameraCaptureOpen = false
  let cameraReturnWindowSize: WindowSize | null = null
  let pendingCameraCloseWindowSize: WindowSize | null = null
  let h5AppletOpen = false
  let h5AppletReturnWindowSize: WindowSize | null = null
  let pendingH5AppletCloseWindowSize: WindowSize | null = null
  let suppressDynamicFitUntil = 0
  let syncMinimalWindowBounds = (): void => {}

  const layoutSuspended = (): boolean => configPanelOpen || inboxOpen || cameraCaptureOpen || h5AppletOpen

  const pendingLayoutCloseWindowSize = (): WindowSize | null =>
    pendingConfigPanelCloseWindowSize ?? pendingInboxCloseWindowSize ?? pendingCameraCloseWindowSize ?? pendingH5AppletCloseWindowSize

  const clearPendingLayoutCloseWindowSize = (target: WindowSize | null): void => {
    if (!target) return
    if (pendingConfigPanelCloseWindowSize === target) pendingConfigPanelCloseWindowSize = null
    if (pendingInboxCloseWindowSize === target) pendingInboxCloseWindowSize = null
    if (pendingCameraCloseWindowSize === target) pendingCameraCloseWindowSize = null
    if (pendingH5AppletCloseWindowSize === target) pendingH5AppletCloseWindowSize = null
  }

  let layoutCoordinator: LiveUiLayoutCoordinator | null = null

  const cancelDynamicWindowFit = (): void => layoutCoordinator?.cancelDynamicFit()

  const scheduleDynamicWindowFit = (attempt = 0): void =>
    Date.now() >= suppressDynamicFitUntil
      ? layoutCoordinator?.scheduleDynamicFit(attempt)
      : undefined

  /**
   * 在「当前 layout」下读人物可见 bounds，若头顶留白明显则把窗口高度减掉一截。
   * Electron 端保持底边不动，所以底部控制条不会漂走。
   */
  const scheduleCompactWindowHeight = (attempt = 0): void => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        layoutFigureInStage()
        const pixiFig = expressionSprite ?? liveModel
        const b = pixiFig?.getBounds() ?? real2dAvatar?.getVisualBounds()
        if (!b) {
          if (attempt < 8) window.setTimeout(() => scheduleCompactWindowHeight(attempt + 1), 180)
          return
        }
        const bar = document.getElementById('liveui-control-bar')
        const barHeight = bar ? Math.ceil(bar.getBoundingClientRect().height) : 120
        const contentLayout = computeAssistantContentLayoutPlan({
          text: bubbleTarget,
          barHeight,
          viewportHeight: window.innerHeight,
          minimalMode,
        })
        const minH = Math.max(360, barHeight + 220, contentLayout.minWindowHeight)
        const topGoal = 10
        const topDelta = Math.floor(b.top - topGoal)
        const nextH = Math.max(minH, Math.min(1000, window.innerHeight - topDelta))
        if (Math.abs(nextH - window.innerHeight) < 6) return
        try {
          if (real2dAvatar) {
            pendingReal2dCompactHeight = nextH
            real2dCompactBaseStageHeight ??= real2dLayoutHeight || real2dStageHeight()
          }
          windowManager.requestLayout({
            mode: 'avatar',
            reason: 'dynamic-figure-fit',
            compactHeight: nextH,
          })
          if (attempt < 6) {
            window.setTimeout(() => scheduleCompactWindowHeight(attempt + 1), 220)
          }
        } catch {
          /* main 不可用 */
        }
      })
    })
  }

  let mouthOpen = 0
  let expression = 'neutral'

  const redrawPlaceholderMouth = (): void => {
    mouth.clear()
    const w = 36 + mouthOpen * 48
    const h = 6 + mouthOpen * 22
    mouth.beginFill(0x2a1a1a, 0.95)
    mouth.drawRoundedRect(-w / 2, -h / 2, w, h, Math.min(12, h / 2))
    mouth.endFill()
  }

  const applyPlaceholderExpression = (expr: string): void => {
    expression = expr
    const palette: Record<string, number> = {
      happy: 0xffe066,
      sad: 0x8899cc,
      angry: 0xff6666,
      thinking: 0xb388ff,
      neutral: 0x6ec5ff,
      surprised: 0x99ffcc,
      frown: 0xaaaaaa,
      blush: 0xffb3c6,
    }
    const fill = palette[expr] ?? 0x6ec5ff
    face.clear()
    face.beginFill(fill, 0.88)
    face.drawCircle(0, 0, FACE_RADIUS)
    face.endFill()
  }

  const setVisualMouth = (open01: number): void => {
    const open = Math.max(0, Math.min(1, open01))
    mouthOpen = open
    if (ttsEnabled) {
      real2dAvatar?.setMouthOpen(open)
    } else if (open <= 0.001) {
      real2dAvatar?.clearMouthOpen()
    }
    if (liveModel) {
      setMouthFromModel(liveModel, open)
    } else {
      redrawPlaceholderMouth()
    }
  }

  /**
   * 气泡内「展出」速度：约 7 字/秒，接近电影字幕节奏（中文 6~8 字/秒），便于跟读；
   * SSE 落后过多时温和提速，避免一口气甩完导致字幕一闪而过。
   */
  const BUBBLE_READING_CHARS_PER_SEC = 7
  /** 三行字幕滚动速度（px/s），约每秒滚一行（15px × 1.55 ≈ 23px/行）。 */
  const BUBBLE_SCROLL_PX_PER_SEC = 28

  let assistantStreamState: StreamLiveUiState = createStreamLiveUiState()
  let typewriterRaf: number | undefined
  let bubbleTarget = ''
  let bubbleShown = 0
  let twLastPerf = 0
  let twCarry = 0
  let bubbleAutoDismissTimer: ReturnType<typeof setTimeout> | undefined
  let bubbleIsStreaming = false
  let minimalMode = false
  let minimalBubbleWaiting = false
  let minimalBubbleStarted = false

  const positionInboxAtComposer = (): void => {
    if (!inboxRoot) return
    const composer = document.getElementById('liveui-composer')
    if (!composer) return
    const rect = composer.getBoundingClientRect()
    const left = Math.max(8, Math.min(window.innerWidth - 56, rect.left + 2))
    const top = Math.max(8, Math.min(window.innerHeight - 56, rect.top + 2))
    inboxRoot.style.left = `${left}px`
    inboxRoot.style.top = `${top}px`
  }

  /** 将气泡定位到控制条上方、叠在人物躯干区域。 */
  const positionBubbleOverFigure = (): void => {
    if (!speechBubble) return
    const controlBar = document.getElementById('liveui-control-bar')
    if (!controlBar) return
    const barRect = controlBar.getBoundingClientRect()
    const gap = 12
    speechBubble.style.bottom = `${window.innerHeight - barRect.top + gap}px`
    positionInboxAtComposer()
  }

  /**
   * 气泡自动隐藏延迟：与 BUBBLE_READING_CHARS_PER_SEC 展出的总时长对齐，再加几秒余韵；
   * 上限避免极长回复一直占屏（仍可在就绪态手动看历史，此处只控制淡出）。
   */
  const estimateReadTimeMs = (text: string): number => {
    const chars = text.replace(/\s+/g, '').length
    const revealMs = (chars / BUBBLE_READING_CHARS_PER_SEC) * 1000 * 1.35
    const tailMs = 9000
    return Math.max(5000, Math.min(180000, revealMs + tailMs))
  }

  const clearBubbleDismiss = (): void => {
    if (bubbleAutoDismissTimer !== undefined) {
      clearTimeout(bubbleAutoDismissTimer)
      bubbleAutoDismissTimer = undefined
    }
  }

  const applyAssistantContentLayout = (text: string): void => {
    if (!speechBubbleText) return
    const bar = document.getElementById('liveui-control-bar')
    const barHeight = bar ? Math.ceil(bar.getBoundingClientRect().height) : 120
    const plan = computeAssistantContentLayoutPlan({
      text,
      barHeight,
      viewportHeight: window.innerHeight,
      minimalMode,
    })
    speechBubbleText.style.setProperty('--liveui-bubble-lines', String(plan.bubbleLines))
  }

  const scheduleBubbleDismiss = (): void => {
    clearBubbleDismiss()
    if (!bubbleTarget.trim()) return
    if (minimalMode && minimalBubbleWaiting) return
    const ms = estimateReadTimeMs(bubbleTarget)
    bubbleAutoDismissTimer = setTimeout(() => {
      speechBubble?.classList.remove('visible')
      speechBubble?.classList.remove('liveui-bubble-waiting')
      speechBubble?.setAttribute('aria-hidden', 'true')
      bubbleAutoDismissTimer = undefined
      scheduleDynamicWindowFit()
    }, ms)
  }

  const stopTypewriter = (): void => {
    if (typewriterRaf !== undefined) {
      cancelAnimationFrame(typewriterRaf)
      typewriterRaf = undefined
    }
  }

  const resetSpeechBubble = (): void => {
    stopTypewriter()
    clearBubbleDismiss()
    bubbleTarget = ''
    bubbleShown = 0
    twLastPerf = 0
    twCarry = 0
    bubbleIsStreaming = true
    minimalBubbleWaiting = false
    minimalBubbleStarted = false
    if (speechBubbleText) {
      applyAssistantContentLayout('')
      speechBubbleText.innerHTML = ''
      speechBubbleText.scrollTop = 0
    }
    speechBubble?.classList.remove('visible')
    speechBubble?.classList.remove('liveui-bubble-waiting')
    speechBubble?.setAttribute('aria-hidden', 'true')
  }

  const setWaitingBubbleFirstChar = (): void => {
    if (!speechBubbleText || !speechBubble) return
    const first = Array.from(bubbleTarget.trimStart())[0] ?? ''
    applyAssistantContentLayout(bubbleTarget)
    speechBubbleText.innerHTML = `<span class="liveui-bubble-first-char">${escapeHtmlText(first)}</span>`
    speechBubbleText.scrollTop = 0
    speechBubble.classList.add('visible', 'liveui-bubble-waiting')
    speechBubble.setAttribute('aria-hidden', 'false')
    positionBubbleOverFigure()
    requestAnimationFrame(() => scheduleDynamicWindowFit())
  }

  const runBubbleReadingFrame = (): void => {
    if (!speechBubbleText || !speechBubble) {
      typewriterRaf = undefined
      return
    }
    speechBubble.classList.remove('liveui-bubble-waiting')
    const now = performance.now()
    const dt = twLastPerf ? Math.min(50, Math.max(0, now - twLastPerf)) : 0
    twLastPerf = now

    let needMoreFrames = false
    let typedThisFrame = false

    if (bubbleShown < bubbleTarget.length) {
      const behind = bubbleTarget.length - bubbleShown
      let cps = BUBBLE_READING_CHARS_PER_SEC
      if (behind > 320) cps *= 2.2
      else if (behind > 180) cps *= 1.6
      else if (behind > 90) cps *= 1.25
      twCarry += (dt / 1000) * cps
      const add = Math.floor(twCarry)
      twCarry -= add
      if (add > 0) {
        bubbleShown = Math.min(bubbleShown + add, bubbleTarget.length)
        speechBubbleText.innerHTML = renderLiveUiBubbleMarkdown(
          bubbleTarget.slice(0, bubbleShown),
        )
        typedThisFrame = true
      }
      needMoreFrames = bubbleShown < bubbleTarget.length
    }

    const el = speechBubbleText
    const maxScroll = el.scrollHeight - el.clientHeight
    if (maxScroll > 0) {
      if (typedThisFrame || needMoreFrames) {
        /**
         * typewriter 还在出字时，最新一行必须在可视区底部（电影字幕：新字总在最下方）。
         * 直接 snap 到底，避免「字打出来但被 max-height 裁掉」的死角。
         */
        el.scrollTop = maxScroll
      } else {
        const lag = maxScroll - el.scrollTop
        if (lag > 0.75) {
          /** 已经停笔但 scroll 还没到位时，按字幕节奏平滑补完最后一段。 */
          const catchup = lag > 60 ? lag * 0.04 : 0
          const step = Math.min(lag, BUBBLE_SCROLL_PX_PER_SEC * (dt / 1000) + catchup)
          el.scrollTop += step
          needMoreFrames = maxScroll - el.scrollTop > 0.75
        }
      }
    }

    speechBubble.classList.add('visible')
    speechBubble.setAttribute('aria-hidden', 'false')
    positionBubbleOverFigure()
    if (minimalMode && (typedThisFrame || needMoreFrames)) scheduleDynamicWindowFit()

    if (needMoreFrames) {
      typewriterRaf = requestAnimationFrame(runBubbleReadingFrame)
    } else {
      typewriterRaf = undefined
      twLastPerf = 0
      if (!bubbleIsStreaming) scheduleBubbleDismiss()
    }
  }

  const ensureTypewriter = (): void => {
    if (typewriterRaf !== undefined) return
    if (!speechBubbleText) return
    twLastPerf = performance.now()
    typewriterRaf = requestAnimationFrame(runBubbleReadingFrame)
  }

  const setBubbleFromDisplayText = (displayText: string): void => {
    if (!speechBubbleText || !speechBubble) return
    bubbleTarget = displayText
    applyAssistantContentLayout(displayText)
    if (!displayText.trim()) {
      resetSpeechBubble()
      return
    }
    clearBubbleDismiss()
    if (bubbleShown > bubbleTarget.length) bubbleShown = bubbleTarget.length
    if (minimalMode && !minimalBubbleStarted) {
      minimalBubbleWaiting = true
      stopTypewriter()
      setWaitingBubbleFirstChar()
      return
    }
    minimalBubbleWaiting = false
    speechBubble.classList.remove('liveui-bubble-waiting')
    speechBubbleText.innerHTML = renderLiveUiBubbleMarkdown(
      bubbleTarget.slice(0, bubbleShown),
    )
    speechBubble.classList.add('visible')
    speechBubble.setAttribute('aria-hidden', 'false')
    positionBubbleOverFigure()
    requestAnimationFrame(() => scheduleDynamicWindowFit())
    ensureTypewriter()
  }

  const startMinimalBubbleReading = (): void => {
    if (!minimalBubbleWaiting || !bubbleTarget.trim()) return
    minimalBubbleWaiting = false
    minimalBubbleStarted = true
    bubbleShown = 0
    twCarry = 0
    twLastPerf = performance.now()
    speechBubble?.classList.remove('liveui-bubble-waiting')
    ensureTypewriter()
  }

  const wireHover = (target: PIXI.Container): void => {
    target.interactive = true
    target.cursor = 'default'
  }

  const configuredRenderer = (window.infinitiLiveUi?.renderer ?? '').trim().toLowerCase()
  const rawSpriteUrl = configuredRenderer === 'live2d'
    ? ''
    : (window.infinitiLiveUi?.spriteExpressionDirFileUrl?.trim() ?? '')
  if (rawSpriteUrl) {
    spriteExpressionDirFileUrl = rawSpriteUrl.endsWith('/') ? rawSpriteUrl : `${rawSpriteUrl}/`
  }
  const wantsReal2d = configuredRenderer === 'real2d'
  let useReal2d = wantsReal2d && Boolean(spriteExpressionDirFileUrl)
  if (wantsReal2d && !spriteExpressionDirFileUrl) {
    console.warn('[liveui] real2d 需要 spriteExpressions.dir，未配置时回退 Live2D/占位')
  }
  const fallbackAvatar = document.getElementById('liveui-avatar-fallback') as HTMLImageElement | null
  const fallbackAvatarUrl = window.infinitiLiveUi?.avatarFallbackFileUrl?.trim() ?? ''
  let useCompactAvatarFallback = false
  if (!spriteExpressionDirFileUrl && fallbackAvatar && fallbackAvatarUrl) {
    fallbackAvatar.src = fallbackAvatarUrl
    fallbackAvatar.hidden = false
    useCompactAvatarFallback = true
    fallbackAvatar.addEventListener('error', () => {
      fallbackAvatar.hidden = true
      useCompactAvatarFallback = false
    }, { once: true })
  }

  spriteEmotionToIdOverride = null
  streamManifestForStrip = null
  if (spriteExpressionDirFileUrl) {
    try {
      const mr = await fetch(new URL('expressions.json', spriteExpressionDirFileUrl))
      if (mr.ok) {
        const raw = await mr.json()
        const m = parseSpriteExpressionManifest(raw)
        spriteEmotionToIdOverride = buildEmotionToSpriteIdFromManifest(m)
        streamManifestForStrip = m
        console.debug('[liveui] 已加载 expressions.json 表情映射')
      }
    } catch (e) {
      console.debug('[liveui] 无 expressions.json 或解析失败，使用内置 exp 映射', e)
    }
  }

  const spritePngUrl = (expBase: string): string =>
    new URL(`${expBase}.png`, spriteExpressionDirFileUrl).href
  const real2dExpressionIds = real2dExpressionIdsFromEmotionMap(spriteEmotionToIdOverride)
  const real2dNeutralExpressionId = real2dExpressionIds?.neutral ?? 'exp01'
  const real2dFigureZoom = clampFigureZoom(window.infinitiLiveUi?.figureZoom)

  const loadSpritePngTexture = (url: string): Promise<PIXI.Texture> =>
    new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(PIXI.Texture.from(img))
      img.onerror = () => reject(new Error(`load failed: ${url}`))
      img.src = url
    })

  if (useReal2d) {
    const real2dPlaceholder = document.createElement('img')
    try {
      real2dPlaceholder.src = spritePngUrl(real2dNeutralExpressionId)
      real2dPlaceholder.alt = ''
      real2dPlaceholder.style.position = 'fixed'
      real2dPlaceholder.style.inset = '0'
      real2dPlaceholder.style.width = '100vw'
      real2dPlaceholder.style.height = '100vh'
      real2dPlaceholder.style.objectFit = 'contain'
      real2dPlaceholder.style.pointerEvents = 'none'
      real2dPlaceholder.style.zIndex = '10'
      real2dPlaceholder.style.visibility = 'hidden'
      real2dPlaceholder.style.transform = `scale(${real2dFigureZoom})`
      real2dPlaceholder.style.transformOrigin = '50% 72%'
      document.body.appendChild(real2dPlaceholder)

      const stage = document.createElement('div')
      stage.id = 'liveui-real2d-stage'
      stage.style.position = 'fixed'
      stage.style.pointerEvents = 'none'
      stage.style.zIndex = '11'
      document.body.appendChild(stage)
      applyReal2dStageLayout(false)
      real2dAvatar = new Real2dLiveUiAdapter({
        container: stage,
        spriteExpressionDirFileUrl,
        expressionIds: real2dExpressionIds,
        figureZoom: real2dFigureZoom,
        width: real2dLayoutWidth,
        height: real2dLayoutHeight,
        onError: (e) => console.warn('[liveui] real2d runtime error:', e),
      })
      await real2dAvatar.init()
      await settleReal2dVerticalPlacement()
      real2dAvatar.setVisible(true)
      real2dPlaceholder.remove()
      app.stage.removeChild(face)
      app.stage.removeChild(mouth)
      scheduleDynamicWindowFit()
      console.debug('[liveui] real2d 已加载', spriteExpressionDirFileUrl)
    } catch (e) {
      real2dPlaceholder.remove()
      document.getElementById('liveui-real2d-stage')?.remove()
      console.warn('[liveui] real2d 加载失败，回退 sprite/Live2D/占位:', e)
      real2dAvatar?.destroy()
      real2dAvatar = null
      useReal2d = false
    }
  }

  if (!useReal2d && spriteExpressionDirFileUrl) {
    try {
      const tex = await loadSpritePngTexture(spritePngUrl(emotionToExpressionId('neutral')))
      const sp = new PIXI.Sprite(tex)
      expressionSprite = sp
      sp.anchor.set(0.5, 0.5)
      spriteNaturalW = Math.max(tex.width, 1)
      spriteNaturalH = Math.max(tex.height, 1)
      app.stage.removeChild(face)
      app.stage.removeChild(mouth)
      app.stage.addChild(sp)
      app.stage.addChild(mouth)
      redrawPlaceholderMouth()
      layoutFigureInStage()
      scheduleDynamicWindowFit()
      wireHover(sp)
      console.debug('[liveui] spriteExpressions PNG 已加载', spriteExpressionDirFileUrl)
    } catch (e) {
      console.warn('[liveui] spriteExpressions 首帧失败，回退 Live2D/占位', e)
      expressionSprite = null
      spriteExpressionDirFileUrl = ''
    }
  }

  const modelUrl = expressionSprite || useReal2d ? '' : (window.infinitiLiveUi?.model3FileUrl?.trim() ?? '')

  if (modelUrl) {
    try {
      await cubism4Ready()
      const model = await Live2DModel.from(modelUrl, { autoInteract: false })
      liveModel = model
      app.stage.removeChild(face)
      app.stage.removeChild(mouth)
      liveModel.anchor.set(0.5, 0.5)
      liveModel.scale.set(1, 1)
      const nb = liveModel.getLocalBounds()
      liveModelNaturalW = Math.max(nb.width, 1)
      liveModelNaturalH = Math.max(nb.height, 1)
      app.stage.addChild(liveModel)
      layoutFigureInStage()
      scheduleDynamicWindowFit()
      wireHover(liveModel)
      void liveModel.motion('Idle', 0).catch(() => {})
      console.debug('[liveui] Live2D Cubism4 模型已加载', modelUrl)
    } catch (e) {
      console.warn(
        useCompactAvatarFallback
          ? '[liveui] Live2D 加载失败，已使用控制条头像兜底'
          : '[liveui] Live2D 加载失败，隐藏默认占位:',
        e,
      )
      liveModel = null
      scheduleDynamicWindowFit()
    }
  } else if (!expressionSprite && !useReal2d) {
    console.debug(
      useCompactAvatarFallback
        ? '[liveui] 使用控制条头像兜底，隐藏默认占位'
        : '[liveui] 无可用形象资源，隐藏默认占位',
    )
    scheduleDynamicWindowFit()
  }

  const currentRendererKind = (): RendererKind => {
    if (real2dAvatar) return 'real2d'
    if (expressionSprite) return 'sprite'
    if (liveModel) return 'live2d'
    return 'placeholder'
  }

  const applyLive2dExpression = (em: string, intensity?: number): void => {
    const adapted = adaptExpression(em, {
      renderer: currentRendererKind(),
      intensity,
      emotionMap: spriteEmotionToIdOverride,
    })
    expression = adapted.expression
    debugEmotion = adapted.expression
    if (typeof adapted.intensity === 'number' && Number.isFinite(adapted.intensity)) {
      debugEmotionIntensity = adapted.intensity
    }
    renderDebugOverlay()
    if (real2dAvatar) {
      real2dAvatar.setEmotion(adapted.expression, adapted.intensity)
      return
    }
    if (expressionSprite && spriteExpressionDirFileUrl) {
      const base = emotionToExpressionId(adapted.expression)
      const url = spritePngUrl(base)
      void loadSpritePngTexture(url)
        .then((tex) => {
          if (!expressionSprite) {
            tex.destroy(true)
            return
          }
          const prev = expressionSprite.texture
          expressionSprite.texture = tex
          const prevAspect = spriteNaturalH > 0 ? spriteNaturalW / spriteNaturalH : 0
          spriteNaturalW = Math.max(tex.width, 1)
          spriteNaturalH = Math.max(tex.height, 1)
          const newAspect = spriteNaturalW / spriteNaturalH
          layoutFigureInStage()
          if (Math.abs(newAspect - prevAspect) > 0.02) {
            scheduleDynamicWindowFit()
          }
          if (prev && prev !== tex) prev.destroy(true)
        })
        .catch((e) => console.warn('[liveui] 表情 PNG 加载失败', base, e))
      return
    }
    if (liveModel) {
      const expId = emotionToExpressionId(adapted.expression)
      void liveModel.expression(expId).catch(() => {
        void liveModel!.expression(0).catch(() => {})
      })
    } else {
      applyPlaceholderExpression(adapted.expression)
    }
  }

  const triggerPixiShake = (): void => {
    const target = liveModel ?? expressionSprite ?? face
    const startX = target.position.x
    const startRot = 'rotation' in target ? target.rotation : 0
    const started = performance.now()
    const duration = 520
    const tick = (): void => {
      const t = Math.min(1, (performance.now() - started) / duration)
      const env = Math.sin(t * Math.PI)
      target.position.x = startX + Math.sin(t * Math.PI * 8) * 5 * env
      if ('rotation' in target) target.rotation = startRot + Math.sin(t * Math.PI * 6) * 0.012 * env
      if (t < 1) {
        requestAnimationFrame(tick)
      } else {
        target.position.x = startX
        if ('rotation' in target) target.rotation = startRot
      }
    }
    requestAnimationFrame(tick)
  }

  const delay = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms))

  const temporarilyUseSpriteExpression = async (expBase: string): Promise<(() => void) | null> => {
    if (!expressionSprite || !spriteExpressionDirFileUrl) return null
    try {
      const tex = await loadSpritePngTexture(spritePngUrl(expBase))
      if (!expressionSprite) {
        tex.destroy(true)
        return null
      }
      const sprite = expressionSprite
      const prevTexture = sprite.texture
      const prevW = spriteNaturalW
      const prevH = spriteNaturalH
      sprite.texture = tex
      spriteNaturalW = Math.max(tex.width, 1)
      spriteNaturalH = Math.max(tex.height, 1)
      layoutFigureInStage()
      scheduleDynamicWindowFit()
      return () => {
        if (!expressionSprite || expressionSprite !== sprite) {
          tex.destroy(true)
          return
        }
        sprite.texture = prevTexture
        spriteNaturalW = prevW
        spriteNaturalH = prevH
        layoutFigureInStage()
        scheduleDynamicWindowFit()
        tex.destroy(true)
      }
    } catch {
      return null
    }
  }

  const temporarilyUseLive2dExpression = async (expId: string): Promise<(() => void) | null> => {
    if (!liveModel || expressionSprite) return null
    try {
      await liveModel.expression(expId)
      return () => {
        void liveModel?.expression(emotionToExpressionId(expression || 'neutral')).catch(() => {
          void liveModel?.expression(0).catch(() => {})
        })
      }
    } catch {
      return null
    }
  }

  window.addEventListener('resize', () => {
    app.renderer.resize(window.innerWidth, window.innerHeight)
    const pendingCloseSize = pendingLayoutCloseWindowSize()
    const closeWindowRestored = isWindowSizeRestored(
      { width: window.innerWidth, height: window.innerHeight },
      pendingCloseSize,
    )
    const isH5AppletRestore = pendingCloseSize != null && pendingCloseSize === pendingH5AppletCloseWindowSize
    // 快应用关闭还原：仅释放 pending，绝不重排 avatar / figure / stage scale。
    // 与图标点击路径行为完全一致：open 切窗口，close 切回来，组件保持原样。
    if (isH5AppletRestore && closeWindowRestored) {
      clearPendingLayoutCloseWindowSize(pendingCloseSize)
      return
    }
    if (!shouldApplyReal2dResizeLayout({
      layoutSuspended: layoutSuspended(),
      pendingConfigPanelCloseRestore: pendingCloseSize != null,
      closeWindowRestored,
    })) {
      return
    }
    if (closeWindowRestored) clearPendingLayoutCloseWindowSize(pendingCloseSize)
    if (real2dAvatar) {
      if (minimalMode) {
        resetReal2dCompactScaleState()
      } else {
        const isReal2dCompactResize =
          pendingReal2dCompactHeight != null &&
          Math.abs(window.innerHeight - pendingReal2dCompactHeight) <= 4
        if (isReal2dCompactResize) pendingReal2dCompactHeight = null
        applyReal2dStageLayout()
        if (isReal2dCompactResize && real2dLayoutHeight > 0) {
          const baseHeight = real2dCompactBaseStageHeight ?? real2dLayoutHeight
          real2dAvatar.setStageScaleCompensation(
            computeReal2dCompactScaleCompensation(baseHeight, real2dLayoutHeight),
          )
        } else {
          resetReal2dCompactScaleState()
        }
        scheduleReal2dVerticalPlacement()
      }
    }
    layoutFigureInStage()
    positionBubbleOverFigure()
    if (!isH5AppletRestore) scheduleDynamicWindowFit()
  })

  const runNormalWindowLayout = (attempt: number): void => {
    app.renderer.resize(window.innerWidth, window.innerHeight)
    if (real2dAvatar) {
      applyReal2dStageLayout()
      scheduleReal2dVerticalPlacement()
    }
    layoutFigureInStage()
    positionBubbleOverFigure()
    if (attempt >= 4) scheduleDynamicWindowFit()
  }

  const refreshNormalWindowLayout = (attempt = 0): void =>
    layoutCoordinator?.refreshNormal(attempt)

  const refreshConfigPanelClosedLayout = (reason: ConfigPanelCloseReason | undefined, attempt = 0): void => {
    layoutCoordinator?.refreshAfterWindowRestore({
      getTarget: () => pendingConfigPanelCloseWindowSize,
      clearTarget: () => {
        pendingConfigPanelCloseWindowSize = null
      },
      beforeRefresh: () => {
        if (shouldResetReal2dCompactScaleOnConfigClose(false, reason)) {
          resetReal2dCompactScaleState()
        }
      },
    }, attempt)
  }

  const refreshInboxClosedLayout = (attempt = 0): void => {
    layoutCoordinator?.refreshAfterWindowRestore({
      getTarget: () => pendingInboxCloseWindowSize,
      clearTarget: () => {
        pendingInboxCloseWindowSize = null
      },
      beforeRefresh: resetReal2dCompactScaleState,
    }, attempt)
  }

  const refreshCameraClosedLayout = (attempt = 0): void => {
    layoutCoordinator?.refreshAfterWindowRestore({
      getTarget: () => pendingCameraCloseWindowSize,
      clearTarget: () => {
        pendingCameraCloseWindowSize = null
      },
      beforeRefresh: resetReal2dCompactScaleState,
    }, attempt)
  }

  layoutCoordinator = createLiveUiLayoutCoordinator({
    isDynamicFitAllowed: () =>
      Date.now() >= suppressDynamicFitUntil &&
      shouldRunDynamicFigureFit({
        minimalMode,
        layoutSuspended: layoutSuspended() || pendingLayoutCloseWindowSize() != null,
      }),
    isMinimalMode: () => minimalMode,
    syncMinimalWindowBounds: () => syncMinimalWindowBounds(),
    runCompactWindowFit: (attempt) => scheduleCompactWindowHeight(attempt),
    runNormalLayout: runNormalWindowLayout,
    getWindowSize: () => ({ width: window.innerWidth, height: window.innerHeight }),
    isWindowSizeRestored,
  })

  const dockEl = document.getElementById('liveui-bottom-dock')
  if (dockEl && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        // 快应用打开/关闭整个生命周期内，绝不让 dock 抖动触发 avatar 重排。
        if (h5AppletOpen || pendingH5AppletCloseWindowSize != null) return
        const pendingCloseSize = pendingLayoutCloseWindowSize()
        if (!shouldApplyReal2dResizeLayout({
          layoutSuspended: layoutSuspended(),
          pendingConfigPanelCloseRestore: pendingCloseSize != null,
          closeWindowRestored: isWindowSizeRestored(
            { width: window.innerWidth, height: window.innerHeight },
            pendingCloseSize,
          ),
        })) {
          return
        }
        layoutFigureInStage()
        applyReal2dStageLayout()
        scheduleReal2dVerticalPlacement()
        positionBubbleOverFigure()
        scheduleDynamicWindowFit()
      })
    })
    ro.observe(dockEl)
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      layoutFigureInStage()
      scheduleDynamicWindowFit()
    })
  })

  const port = readPort()
  const wsUrl = `ws://127.0.0.1:${port}`
  const socket = new ReconnectingWebSocket(wsUrl)
  const h5AppletHost = h5AppletRoot
    ? createH5AppletHost({
      root: h5AppletRoot,
      socket,
      onInteractiveNeeded: () => forceWindowInteractive(),
      onBeforeLaunch: () => {
        // 唯一的 snapshot 入口：图标点击与外部 launch(key)（含 /showmemagic 链路）共用此回调，
        // 保证两条路径在 WS 往返之前就锁定"打开前窗口尺寸"。
        h5AppletReturnWindowSize = { width: window.innerWidth, height: window.innerHeight }
        pendingH5AppletCloseWindowSize = null
        // 期间冻结所有动态窗口压缩，确保 avatar 状态在快应用生命周期内保持原样。
        cancelDynamicWindowFit()
        pendingReal2dCompactHeight = null
        suppressDynamicFitUntil = Number.POSITIVE_INFINITY
      },
      onOpenChange: (open) => {
        if (open) {
          // 兜底：如果 applet 不是经 launch() 打开（例如服务端直接 CREATE），仍然记一次 snapshot。
          h5AppletReturnWindowSize ??= { width: window.innerWidth, height: window.innerHeight }
          pendingH5AppletCloseWindowSize = null
          suppressDynamicFitUntil = Number.POSITIVE_INFINITY
          cancelDynamicWindowFit()
        } else {
          pendingH5AppletCloseWindowSize = h5AppletReturnWindowSize
          h5AppletReturnWindowSize = null
          suppressDynamicFitUntil = Date.now() + 600
          cancelDynamicWindowFit()
        }
        h5AppletOpen = open
        document.body.classList.toggle('liveui-h5-applet-open', open)
        windowManager.requestLayout({ mode: 'h5Applet', reason: 'h5-applet', open })
        // 不调用 refreshH5AppletClosedLayout：H5 关闭只是窗口大小回退，
        // 期间不能触发任何 avatar/figure 重排或 stage scale compensation 重算。
      },
    })
    : null
  const configPanel = initConfigPanel({
    socket,
    onOpenChange: (open, reason) => {
      if (open) {
        configPanelReturnWindowSize = { width: window.innerWidth, height: window.innerHeight }
        pendingConfigPanelCloseWindowSize = null
      } else {
        pendingConfigPanelCloseWindowSize = configPanelReturnWindowSize
        configPanelReturnWindowSize = null
      }
      configPanelOpen = open
      document.body.classList.toggle('liveui-config-open', open)
      windowManager.requestLayout({ mode: 'config', reason: 'config-panel', open })
      if (configPanelLayoutAction(open) === 'suspend-fit') {
        cancelDynamicWindowFit()
        return
      }
      refreshConfigPanelClosedLayout(reason)
    },
  })

  const INPUT_HISTORY_STORAGE_KEY = 'infiniti-liveui-input-history-v1'
  const INPUT_HISTORY_MAX = 100
  const SLASH_MENU_MAX_ROWS = 10
  let slashMenuOpenLive = false
  let slashRows: SlashRow[] = []
  let slashSel = 0
  let slashSig = ''
  let inputHistory: string[] = []
  let inputHistoryIndex = 0
  let inputHistoryDraft = ''
  const slashMenuEl = document.getElementById('liveui-slash-menu')
  const slashHintEl = document.getElementById('liveui-slash-menu-hint')
  const slashListEl = document.getElementById('liveui-slash-menu-list')
  const setInboxWindowOpen = (open: boolean): void => {
    if (open) {
      inboxReturnWindowSize = { width: window.innerWidth, height: window.innerHeight }
      pendingInboxCloseWindowSize = null
    } else {
      pendingInboxCloseWindowSize = inboxReturnWindowSize
      inboxReturnWindowSize = null
    }
    inboxOpen = open
    windowManager.requestLayout({ mode: 'inbox', reason: 'inbox-panel', open })
    if (open) {
      cancelDynamicWindowFit()
      return
    }
    refreshInboxClosedLayout()
  }
  const inboxController = createLiveInboxController({
    root: inboxRoot,
    toggle: inboxToggle,
    panel: inboxPanel,
    socket,
    positionAtComposer: positionInboxAtComposer,
    setInboxOpen: setInboxWindowOpen,
    savePath: (request) => window.infinitiLiveUi?.savePath?.(request),
    getPort: () => window.infinitiLiveUi?.port || new URLSearchParams(window.location.search).get('port') || '8080',
  })

  const loadInputHistory = (): string[] => {
    try {
      return parseInputHistory(window.localStorage.getItem(INPUT_HISTORY_STORAGE_KEY), INPUT_HISTORY_MAX)
    } catch {
      return []
    }
  }

  const saveInputHistory = (): void => {
    try {
      window.localStorage.setItem(
        INPUT_HISTORY_STORAGE_KEY,
        JSON.stringify(inputHistory.slice(-INPUT_HISTORY_MAX)),
      )
    } catch {
      /* ignore storage failures */
    }
  }

  const rememberInputHistory = (raw: string): void => {
    const prev = inputHistory
    const next = rememberInput(inputHistory, raw, INPUT_HISTORY_MAX)
    inputHistory = next.items
    inputHistoryIndex = next.index
    inputHistoryDraft = next.draft
    if (inputHistory !== prev) {
      saveInputHistory()
    }
  }

  inputHistory = loadInputHistory()
  inputHistoryIndex = inputHistory.length

  const pushComposerDraft = (): void => {
    if (!userLineInput) return
    sendSocketMessage(socket, 'USER_COMPOSER', { text: userLineInput.value })
  }

  const setComposerValue = (value: string): void => {
    if (!userLineInput) return
    userLineInput.value = value
    const pos = value.length
    userLineInput.setSelectionRange(pos, pos)
    pushComposerDraft()
    touchConvActivity()
  }

  const canNavigateInputHistory = (direction: 'up' | 'down'): boolean => {
    if (!userLineInput) return false
    return canNavigateHistoryValue(direction, userLineInput.value, userLineInput.selectionStart, inputHistory.length)
  }

  const navigateInputHistory = (direction: 'up' | 'down'): boolean => {
    if (!userLineInput || !canNavigateInputHistory(direction)) return false
    const next = navigateHistoryValue(
      { items: inputHistory, index: inputHistoryIndex, draft: inputHistoryDraft },
      direction,
      userLineInput.value,
    )
    inputHistory = next.items
    inputHistoryIndex = next.index
    inputHistoryDraft = next.draft
    if (!next.changed) return true
    setComposerValue(next.value)
    return true
  }

  const applySlashInsert = (): void => {
    if (!userLineInput || slashRows.length === 0) return
    const item = slashRows[slashSel]
    if (!item) return
    userLineInput.value = slashInsertText(item.insert)
    pushComposerDraft()
  }

  const renderLiveSlashMenu = (): void => {
    if (!slashMenuEl || !slashListEl) return
    if (!slashMenuOpenLive) {
      slashMenuEl.hidden = true
      slashMenuEl.setAttribute('aria-hidden', 'true')
      requestAnimationFrame(() => scheduleDynamicWindowFit())
      return
    }
    slashMenuEl.hidden = false
    slashMenuEl.setAttribute('aria-hidden', 'false')
    const total = slashRows.length
    if (slashHintEl) {
      slashHintEl.textContent = slashMenuHintText(total)
    }
    const windowed = slashMenuWindow(slashRows, slashSel, SLASH_MENU_MAX_ROWS)
    slashSel = windowed.selected
    slashListEl.replaceChildren()
    for (let i = 0; i < windowed.visible.length; i++) {
      const item = windowed.visible[i]!
      const globalIdx = windowed.start + i
      const row = document.createElement('li')
      row.className = `liveui-slash-row${globalIdx === slashSel ? ' liveui-slash-row--active' : ''}`
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(globalIdx === slashSel))
      const kindEl = document.createElement('span')
      kindEl.className = 'liveui-slash-kind'
      kindEl.textContent = item.kind === 'command' ? '[命令]' : '[工具]'
      const labEl = document.createElement('span')
      labEl.className = 'liveui-slash-label'
      labEl.textContent = item.label
      const descEl = document.createElement('span')
      descEl.className = 'liveui-slash-desc'
      descEl.textContent = ` — ${item.desc}`
      row.append(kindEl, labEl, descEl)
      slashListEl.append(row)
    }
    requestAnimationFrame(() => scheduleDynamicWindowFit())
  }

  let lastConvActivity = Date.now()
  let statusPillVariant: LiveUiStatusVariant = 'ready'
  let idleMotionBusy = false
  let maybeAutoStartAsr = (): void => {}
  let exitVoiceModeForMinimal = (): void => {}
  let forceWindowInteractive = (): void => {}

  const touchConvActivity = (): void => {
    lastConvActivity = Date.now()
  }

  const sendLiveUiInteraction = (kind: 'head_pat' | 'body_poke'): void => {
    touchConvActivity()
    sendSocketMessage(socket, 'LIVEUI_INTERACTION', { kind })
  }

  let cameraCapturing = false
  let cameraCaptureSeq = 0
  let activeCameraRequestId = ''
  let previewPhotoRequestId = ''
  let previewPhotoVision: LiveUiVisionAttachment | null = null
  let attachedPhotoRequestId = ''
  let attachedPhotoVision: LiveUiVisionAttachment | null = null
  let attachedFiles: ChatAttachment[] = []
  let clearConfirmedPhotoUi: (notifyServer?: boolean) => void = () => {}
  let cameraUiTimeout: number | undefined

  const getCurrentLocation = (timeoutMs = 1500): Promise<LiveUiVisionAttachment['location'] | undefined> => {
    if (!navigator.geolocation) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      let settled = false
      const done = (value: LiveUiVisionAttachment['location'] | undefined): void => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const timer = window.setTimeout(() => done(undefined), timeoutMs)
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          window.clearTimeout(timer)
          done({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          })
        },
        () => {
          window.clearTimeout(timer)
          done(undefined)
        },
        { enableHighAccuracy: false, maximumAge: 60_000, timeout: timeoutMs },
      )
    })
  }

  const stopMediaStream = (stream: MediaStream): void => {
    for (const track of stream.getTracks()) {
      try {
        console.debug(`[liveui] stop camera/mic track: kind=${track.kind}, label="${track.label}", state=${track.readyState}`)
        track.stop()
      } catch {
        /* ignore */
      }
    }
  }

  const getCameraStreamWithTimeout = (timeoutMs = 8_000): Promise<MediaStream> => {
    if (!navigator.mediaDevices?.getUserMedia) {
      return Promise.reject(new Error('当前环境不支持摄像头'))
    }
    console.debug('[liveui] getUserMedia(camera) requesting one-shot stream')
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        fn()
      }
      const timer = window.setTimeout(() => {
        finish(() => reject(new Error(`摄像头请求超时（${timeoutMs}ms）`)))
      }, timeoutMs)
      navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
        audio: false,
      }).then(
        (stream) => {
          if (settled) {
            stopMediaStream(stream)
            return
          }
          for (const track of stream.getVideoTracks()) {
            console.debug(
              `[liveui] camera stream track: label="${track.label}", state=${track.readyState}, muted=${track.muted}, settings=${JSON.stringify(track.getSettings())}`,
            )
          }
          finish(() => resolve(stream))
        },
        (e) => finish(() => reject(e)),
      )
    })
  }

  const drawCameraSourceToVision = (
    source: CanvasImageSource,
    srcW: number,
    srcH: number,
    location: LiveUiVisionAttachment['location'] | undefined,
  ): LiveUiVisionAttachment => {
    const { width: w, height: h } = scaledCaptureSize(srcW, srcH)
    const canvasEl = document.createElement('canvas')
    canvasEl.width = w
    canvasEl.height = h
    const ctx = canvasEl.getContext('2d')
    if (!ctx) throw new Error('无法创建图片画布')
    ctx.drawImage(source, 0, 0, w, h)
    const imageBase64 = canvasEl.toDataURL('image/jpeg', 0.72).split(',')[1]
    if (!imageBase64) throw new Error('图片编码失败')
    return {
      imageBase64,
      mediaType: 'image/jpeg',
      capturedAt: new Date().toISOString(),
      ...(location ? { location } : {}),
    }
  }

  const captureVideoFallbackFrame = async (
    stream: MediaStream,
    location: LiveUiVisionAttachment['location'] | undefined,
  ): Promise<LiveUiVisionAttachment> => {
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.autoplay = true
    video.style.position = 'fixed'
    video.style.left = '-9999px'
    video.style.top = '0'
    video.style.width = '1px'
    video.style.height = '1px'
    video.srcObject = stream
    document.body.appendChild(video)
    console.debug('[liveui] video fallback play start')
    video.play().then(
      () => console.debug('[liveui] video fallback play resolved'),
      (e) => console.warn(`[liveui] video fallback play rejected: ${describeCameraError(e)}`),
    )
    await new Promise<void>((resolve, reject) => {
      const startedAt = performance.now()
      const tick = (): void => {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0) {
          resolve()
          return
        }
        if (performance.now() - startedAt > 3_000) {
          reject(new Error('摄像头没有输出视频帧'))
          return
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    try {
      return drawCameraSourceToVision(video, video.videoWidth, video.videoHeight, location)
    } finally {
      video.pause()
      video.srcObject = null
      video.remove()
    }
  }

  const grabImageCaptureFrame = async (track: MediaStreamTrack, timeoutMs = 2500): Promise<ImageBitmap> => {
    if (!window.ImageCapture) throw new Error('ImageCapture unavailable')
    return await Promise.race([
      new window.ImageCapture(track).grabFrame(),
      new Promise<never>((_, reject) => {
        window.setTimeout(() => reject(new Error(`ImageCapture.grabFrame 超时（${timeoutMs}ms）`)), timeoutMs)
      }),
    ])
  }

  const captureLocalCameraPhoto = async (): Promise<LiveUiVisionAttachment> => {
    console.debug('[liveui] local camera capture start')
    const locationPromise = getCurrentLocation(1200)
    const stream = await getCameraStreamWithTimeout()
    try {
      const location = await locationPromise
      const track = stream.getVideoTracks()[0]
      if (track && window.ImageCapture) {
        try {
          console.debug('[liveui] ImageCapture.grabFrame start')
          const bitmap = await grabImageCaptureFrame(track)
          try {
            console.debug(`[liveui] ImageCapture.grabFrame ok: ${bitmap.width}x${bitmap.height}`)
            return drawCameraSourceToVision(bitmap, bitmap.width, bitmap.height, location)
          } finally {
            bitmap.close()
          }
        } catch (e) {
          console.warn(`[liveui] ImageCapture.grabFrame 失败，改用 video 首帧: ${describeCameraError(e)}`)
        }
      }
      console.debug('[liveui] falling back to video element frame capture')
      return await captureVideoFallbackFrame(stream, location)
    } finally {
      stopMediaStream(stream)
    }
  }

  type PreparedCameraCapture = {
    stream: MediaStream
    video: HTMLVideoElement
    capture: (location: LiveUiVisionAttachment['location'] | undefined) => LiveUiVisionAttachment
    close: () => void
  }

  const prepareCameraCapture = async (): Promise<PreparedCameraCapture> => {
    const stream = await getCameraStreamWithTimeout()
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.autoplay = true
    video.style.position = 'fixed'
    video.style.left = '-9999px'
    video.style.top = '0'
    video.style.width = '1px'
    video.style.height = '1px'
    video.srcObject = stream
    document.body.appendChild(video)
    console.debug('[liveui] camera prepare video play start')
    video.play().then(
      () => console.debug('[liveui] camera prepare video play resolved'),
      (e) => console.warn(`[liveui] camera prepare video play rejected: ${describeCameraError(e)}`),
    )
    await new Promise<void>((resolve, reject) => {
      const startedAt = performance.now()
      const tick = (): void => {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0) {
          resolve()
          return
        }
        if (performance.now() - startedAt > 4_000) {
          reject(new Error('摄像头没有输出视频帧'))
          return
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    let closed = false
    const close = (): void => {
      if (closed) return
      closed = true
      video.pause()
      video.srcObject = null
      video.remove()
      stopMediaStream(stream)
    }
    return {
      stream,
      video,
      capture: (location) => drawCameraSourceToVision(video, video.videoWidth, video.videoHeight, location),
      close,
    }
  }

  const parseVisionAttachment = (raw: unknown): LiveUiVisionAttachment | null => {
    if (!raw || typeof raw !== 'object') return null
    const v = raw as {
      imageBase64?: unknown
      mediaType?: unknown
      capturedAt?: unknown
      location?: unknown
    }
    if (
      typeof v.imageBase64 !== 'string' ||
      typeof v.capturedAt !== 'string' ||
      (v.mediaType !== 'image/jpeg' && v.mediaType !== 'image/png' && v.mediaType !== 'image/webp')
    ) {
      return null
    }
    const out: LiveUiVisionAttachment = {
      imageBase64: v.imageBase64,
      mediaType: v.mediaType,
      capturedAt: v.capturedAt,
    }
    if (v.location && typeof v.location === 'object') {
      const loc = v.location as { latitude?: unknown; longitude?: unknown; accuracy?: unknown }
      if (
        typeof loc.latitude === 'number' &&
        Number.isFinite(loc.latitude) &&
        typeof loc.longitude === 'number' &&
        Number.isFinite(loc.longitude)
      ) {
        out.location = { latitude: loc.latitude, longitude: loc.longitude }
        if (typeof loc.accuracy === 'number' && Number.isFinite(loc.accuracy)) {
          out.location.accuracy = loc.accuracy
        }
      }
    }
    return out
  }

  const sendUserCommand = (line: string): void => {
    touchConvActivity()
    const trimmedStart = line.trimStart()
    const shouldSendAttachments =
      attachedFiles.length > 0 &&
      (
        !trimmedStart.startsWith('/') ||
        trimmedStart === '/avatargen' ||
        trimmedStart.startsWith('/avatargen ') ||
        trimmedStart === '/video' ||
        trimmedStart.startsWith('/video ') ||
        trimmedStart === '/seedance' ||
        trimmedStart.startsWith('/seedance ')
      )
    const payload = {
      line,
      ...(shouldSendAttachments ? { attachments: attachedFiles } : {}),
    }
    if (!sendSocketMessage(socket, 'USER_INPUT', payload)) return
    if ((attachedPhotoVision || attachedFiles.length) && !trimmedStart.startsWith('/')) {
      clearConfirmedPhotoUi(false)
      attachedFiles = []
      renderAttachments()
    }
  }

  const classifyHitNames = (hits: string[]): 'head' | 'body' | null => {
    for (const id of hits) {
      if (HIT_HEAD_RE.test(id)) return 'head'
    }
    for (const id of hits) {
      if (HIT_BODY_RE.test(id)) return 'body'
    }
    return null
  }

  async function tryBodyPokeMotion(model: InstanceType<typeof Live2DModel>): Promise<void> {
    for (const m of LIVE2D_BODY_POKE_MOTIONS) {
      const ok = await model.motion(m.group, m.index).catch(() => false)
      if (ok) return
    }
  }

  const wirePointerInteractions = (): void => {
    if (liveModel) {
      liveModel.cursor = 'pointer'
      liveModel.on('pointertap', (e: PIXI.InteractionEvent) => {
        const gp = e.data.global
        const hits = liveModel!.hitTest(gp.x, gp.y)
        let zone = classifyHitNames(hits)
        if (!zone && liveModel!.containsPoint(gp)) {
          const lp = e.data.getLocalPosition(liveModel!)
          zone = lp.y < 0 ? 'head' : 'body'
        }
        if (zone === 'head') {
          applyLive2dExpression('blush')
          sendLiveUiInteraction('head_pat')
        } else if (zone === 'body') {
          applyLive2dExpression('angry')
          void tryBodyPokeMotion(liveModel!)
          sendLiveUiInteraction('body_poke')
        }
      })
    } else if (expressionSprite) {
      expressionSprite.cursor = 'pointer'
      expressionSprite.on('pointertap', (e: PIXI.InteractionEvent) => {
        const lp = e.data.getLocalPosition(expressionSprite!)
        const head = lp.y < -spriteNaturalH * 0.12
        applyLive2dExpression(head ? 'blush' : 'angry')
        sendLiveUiInteraction(head ? 'head_pat' : 'body_poke')
      })
    } else {
      face.cursor = 'pointer'
      face.on('pointertap', (e: PIXI.InteractionEvent) => {
        const lp = e.data.getLocalPosition(face)
        const head = lp.y < -FACE_RADIUS * 0.22
        applyLive2dExpression(head ? 'blush' : 'angry')
        sendLiveUiInteraction(head ? 'head_pat' : 'body_poke')
      })
    }
  }

  // ── TTS 开关 ──
  let ttsEnabled = window.infinitiLiveUi?.voiceMic?.ttsAutoEnabled !== false
  let ttsAvailable = false

  // ── 音频播放系统（TTS AUDIO_CHUNK） ──
  type QueuedAudio = { kind: 'encoded'; buf: ArrayBuffer } | { kind: 'decoded'; buffer: AudioBuffer }

  let audioCtx: AudioContext | null = null
  let audioPlaying = false
  const audioQueue: QueuedAudio[] = []
  let audioMouthRaf: number | undefined
  let audioSource: AudioBufferSourceNode | null = null
  let audioAnalyser: AnalyserNode | null = null
  const TTS_MOUTH_ANALYSER_FFT_SIZE = 256
  const audioAnalyserData = new Uint8Array(TTS_MOUTH_ANALYSER_FFT_SIZE / 2)
  let ttsActive = false

  /** PCM 流式：按 AudioContext 时间线首尾相接，避免多块 BufferSource 链式播放的缝隙与裂音 */
  let pcmTailTime = 0
  /**
   * 新一轮 TTS 的首块排程前增加短暂 playout lead，给网络/解码留一点余量，减轻 underrun 断续感。
   * AUDIO_RESET 时复位。
   */
  let pcmPlayheadPrimed = false
  const PCM_STREAM_PLAYOUT_LEAD_SEC = 0.1
  /** 合并 TTS 小块为约 50ms 再排程，减少 Web Audio BufferSource 数量，缓解长对话卡顿与块衔接裂音 */
  const PCM_S16_COALESCE_SEC = 0.05
  const PCM_S16_TAIL_FLUSH_MS = 10
  let pcmS16FlushTimer: ReturnType<typeof setTimeout> | null = null
  const pcmS16Coalescer = new PcmS16Coalescer(PCM_S16_COALESCE_SEC)
  let pcmScheduleChain: Promise<void> = Promise.resolve()
  let activePcmSources = 0
  const activePcmSourceNodes: AudioBufferSourceNode[] = []
  let ttsPcmAnalyser: AnalyserNode | null = null

  const ensureAudioCtx = (): AudioContext => {
    if (!audioCtx) {
      audioCtx = new AudioContext()
      console.debug('[liveui] AudioContext 已创建, state:', audioCtx.state)
    }
    return audioCtx
  }

  const ensureTtsPcmAnalyser = (ctx: AudioContext): AnalyserNode => {
    if (!ttsPcmAnalyser || ttsPcmAnalyser.context !== ctx) {
      ttsPcmAnalyser = ctx.createAnalyser()
      ttsPcmAnalyser.fftSize = TTS_MOUTH_ANALYSER_FFT_SIZE
      ttsPcmAnalyser.connect(ctx.destination)
    }
    return ttsPcmAnalyser
  }

  /** MOSS generate-stream：pcm_s16le 交织 → AudioBuffer（不经过 decodeAudioData）。 */
  function pcmS16leToAudioBuffer(
    ctx: AudioContext,
    pcmAb: ArrayBuffer,
    sampleRate: number,
    channels: number,
  ): AudioBuffer {
    const dv = new DataView(pcmAb)
    const frameBytes = 2 * channels
    const frameCount = Math.floor(pcmAb.byteLength / frameBytes)
    const buf = ctx.createBuffer(channels, frameCount, sampleRate)
    let o = 0
    for (let i = 0; i < frameCount; i++) {
      for (let ch = 0; ch < channels; ch++) {
        buf.getChannelData(ch)[i] = dv.getInt16(o, true) / 32768
        o += 2
      }
    }
    return buf
  }

  const discardPcmS16Spill = (): void => {
    if (pcmS16FlushTimer != null) {
      clearTimeout(pcmS16FlushTimer)
      pcmS16FlushTimer = null
    }
    pcmS16Coalescer.reset()
  }

  const appendAndEmitPcmS16le = (ctx: AudioContext, pcm: Uint8Array, sampleRate: number, channels: number): void => {
    for (const part of pcmS16Coalescer.append(pcm, sampleRate, channels)) {
      const dec = pcmS16leToAudioBuffer(
        ctx,
        part.pcm.buffer.slice(part.pcm.byteOffset, part.pcm.byteOffset + part.pcm.byteLength),
        part.sampleRate,
        part.channels,
      )
      schedulePcmChunk(dec)
    }
    if (pcmS16FlushTimer != null) {
      clearTimeout(pcmS16FlushTimer)
      pcmS16FlushTimer = null
    }
    pcmS16FlushTimer = window.setTimeout(() => {
      pcmS16FlushTimer = null
      void flushPcmS16SpillToCtx(ensureAudioCtx(), false)
    }, PCM_S16_TAIL_FLUSH_MS)
  }

  function flushPcmS16SpillToCtx(ctx: AudioContext, forceAll: boolean): void {
    for (const part of pcmS16Coalescer.flush(forceAll)) {
      const dec = pcmS16leToAudioBuffer(
        ctx,
        part.pcm.buffer.slice(part.pcm.byteOffset, part.pcm.byteOffset + part.pcm.byteLength),
        part.sampleRate,
        part.channels,
      )
      schedulePcmChunk(dec)
    }
  }

  const setMouthFromAudio = (): void => {
    if (!audioAnalyser) return
    audioAnalyser.getByteTimeDomainData(audioAnalyserData)
    let sum = 0
    for (let i = 0; i < audioAnalyserData.length; i++) {
      const v = (audioAnalyserData[i]! - 128) / 128
      sum += v * v
    }
    const rms = Math.sqrt(sum / audioAnalyserData.length)
    const open = Math.min(1, rms * 3.5)
    setVisualMouth(open)
    if (audioPlaying) {
      audioMouthRaf = requestAnimationFrame(setMouthFromAudio)
    }
  }

  const finishTtsPlaybackIfIdle = (): void => {
    if (activePcmSources > 0) return
    /* 非 PCM 路径仍由单个 audioSource 驱动，勿在此处抢停 */
    if (audioSource) return
    pcmTailTime = 0
    if (audioQueue.length > 0) {
      audioPlaying = false
      playNextInQueue()
      return
    }
    pcmTailTime = 0
    pcmPlayheadPrimed = false
    if (audioMouthRaf) cancelAnimationFrame(audioMouthRaf)
    audioMouthRaf = undefined
    audioAnalyser = null
    setVisualMouth(0)
    audioPlaying = false
    ttsActive = false
  }

  const schedulePcmChunk = (decoded: AudioBuffer): void => {
    const ctx = ensureAudioCtx()
    const src = ctx.createBufferSource()
    src.buffer = decoded
    const analyser = ensureTtsPcmAnalyser(ctx)
    src.connect(analyser)
    audioAnalyser = analyser

    pcmScheduleChain = pcmScheduleChain.then(async () => {
      try {
        if (ctx.state === 'suspended') {
          await ctx.resume()
          console.debug('[liveui] AudioContext resumed, state:', ctx.state)
        }
      } catch (e) {
        console.warn('[liveui] AudioContext.resume 失败（可点击页面后再试）:', e)
      }

      const now = ctx.currentTime
      let t0: number
      if (!pcmPlayheadPrimed) {
        t0 = now + PCM_STREAM_PLAYOUT_LEAD_SEC
        pcmPlayheadPrimed = true
      } else {
        t0 = pcmTailTime > 0 ? Math.max(now, pcmTailTime) : now
      }
      pcmTailTime = t0 + decoded.duration
      activePcmSources++
      ttsActive = true
      audioPlaying = true
      if (audioMouthRaf === undefined) {
        audioMouthRaf = requestAnimationFrame(setMouthFromAudio)
      }
      console.debug(
        `[liveui] PCM 已排程 @${t0.toFixed(3)}s, 时长 ${decoded.duration.toFixed(3)}s, sr=${decoded.sampleRate}, ch=${decoded.numberOfChannels}`,
      )

      activePcmSourceNodes.push(src)
      src.onended = () => {
        const i = activePcmSourceNodes.indexOf(src)
        if (i >= 0) activePcmSourceNodes.splice(i, 1)
        activePcmSources = Math.max(0, activePcmSources - 1)
        audioPlaying = activePcmSources > 0
        finishTtsPlaybackIfIdle()
      }
      try {
        src.start(t0)
      } catch (e) {
        console.warn('[liveui] PCM start 失败:', e)
        const j = activePcmSourceNodes.indexOf(src)
        if (j >= 0) activePcmSourceNodes.splice(j, 1)
        activePcmSources = Math.max(0, activePcmSources - 1)
        finishTtsPlaybackIfIdle()
      }
    })
  }

  const playNextInQueue = (): void => {
    if (audioPlaying || audioQueue.length === 0) return
    const item = audioQueue.shift()!
    audioPlaying = true
    ttsActive = true
    const ctx = ensureAudioCtx()

    void (async () => {
      try {
        if (ctx.state === 'suspended') {
          await ctx.resume()
          console.debug('[liveui] AudioContext resumed, state:', ctx.state)
        }
      } catch (e) {
        console.warn('[liveui] AudioContext.resume 失败（可点击页面后再试）:', e)
      }

      try {
        let decoded: AudioBuffer
        if (item.kind === 'decoded') {
          decoded = item.buffer
          console.debug(
            `[liveui] PCM 块播放: ${decoded.duration.toFixed(3)}s, sr=${decoded.sampleRate}, ch=${decoded.numberOfChannels}`,
          )
        } else {
          pcmTailTime = 0
          decoded = await ctx.decodeAudioData(item.buf.slice(0))
          console.debug(`[liveui] 音频解码成功: ${decoded.duration.toFixed(2)}s, sampleRate: ${decoded.sampleRate}`)
        }
        const src = ctx.createBufferSource()
        src.buffer = decoded
        const analyser = ctx.createAnalyser()
        analyser.fftSize = TTS_MOUTH_ANALYSER_FFT_SIZE
        src.connect(analyser)
        analyser.connect(ctx.destination)
        audioSource = src
        audioAnalyser = analyser
        audioMouthRaf = requestAnimationFrame(setMouthFromAudio)
        src.onended = () => {
          audioPlaying = false
          audioSource = null
          audioAnalyser = null
          if (audioMouthRaf) cancelAnimationFrame(audioMouthRaf)
          audioMouthRaf = undefined
          setVisualMouth(0)
          if (audioQueue.length > 0) {
            playNextInQueue()
          } else {
            ttsActive = false
          }
        }
        src.start()
      } catch (e) {
        console.warn('[liveui] 音频解码/播放失败:', e)
        audioPlaying = false
        ttsActive = false
        playNextInQueue()
      }
    })()
  }

  const enqueueAudioChunk = (data: AudioChunkMsg['data']): void => {
    const ctx = ensureAudioCtx()
    if (data.format === 'pcm_s16le') {
      const { sampleRate: sr, channels: ch } = normalizePcmAudioMeta(data.sampleRate, data.channels)
      const u8 = new Uint8Array(base64ToArrayBuffer(data.audioBase64))
      console.debug(`[liveui] 收到 PCM 块: ${u8.byteLength} bytes, ch=${ch}, 队列: ${audioQueue.length}`)
      appendAndEmitPcmS16le(ctx, u8, sr, ch)
    } else {
      const pcmAb = base64ToArrayBuffer(data.audioBase64)
      console.debug(`[liveui] 收到音频块: ${pcmAb.byteLength} bytes (${data.format}), 队列: ${audioQueue.length}`)
      audioQueue.push({ kind: 'encoded', buf: pcmAb })
      playNextInQueue()
    }
  }

  const resetAudioQueue = (): void => {
    audioQueue.length = 0
    discardPcmS16Spill()
    pcmTailTime = 0
    pcmPlayheadPrimed = false
    pcmScheduleChain = Promise.resolve()
    for (const s of activePcmSourceNodes) {
      try {
        s.stop()
      } catch {
        /* ignore */
      }
    }
    activePcmSourceNodes.length = 0
    activePcmSources = 0
    if (audioSource) {
      try { audioSource.stop() } catch { /* ignore */ }
      audioSource = null
    }
    audioPlaying = false
    ttsActive = false
    if (audioMouthRaf) cancelAnimationFrame(audioMouthRaf)
    audioMouthRaf = undefined
    audioAnalyser = null
    setVisualMouth(0)
  }

  socket.addEventListener('open', () => {
    console.debug('[liveui] WebSocket 已连接', wsUrl)
    touchConvActivity()
    pushComposerDraft()
  })
  socket.addEventListener('close', () => {
    console.debug('[liveui] WebSocket 已断开')
  })
  socket.addEventListener('error', () => {
    console.warn('[liveui] WebSocket 错误')
  })

  socket.addEventListener('message', (ev) => {
    let msg: Msg
    try {
      msg = JSON.parse(String(ev.data)) as Msg
    } catch {
      return
    }
    if (msg.type === 'SYNC_PARAM' && msg.data?.id === 'ParamMouthOpenY') {
      if (ttsEnabled && !ttsActive) {
        setVisualMouth(Math.max(0, Math.min(1, Number(msg.data.value) || 0)))
      }
    } else if (msg.type === 'INBOX_UPDATE') {
      inboxController.setUnreadRaw(msg.data?.unread)
    } else if (msg.type === 'INBOX_OPEN') {
      inboxController.openRaw(msg.data?.items)
    } else if (msg.type === 'INBOX_SAVE_RESULT') {
      const text = typeof msg.data?.message === 'string' ? msg.data.message : ''
      if (msg.data?.ok) {
        console.debug('[liveui] inbox save:', text)
      } else {
        console.warn('[liveui] inbox save failed:', text)
      }
    } else if (msg.type === 'H5_APPLET_CREATE') {
      const data = msg.data
      if (
        h5AppletHost &&
        typeof data?.appId === 'string' &&
        typeof data.title === 'string' &&
        typeof data.description === 'string' &&
        typeof data.html === 'string' &&
        (data.launchMode === 'live_panel' || data.launchMode === 'floating' || data.launchMode === 'fullscreen' || data.launchMode === 'overlay')
      ) {
        h5AppletHost.create({
          appId: data.appId,
          title: data.title,
          description: data.description,
          launchMode: data.launchMode,
          html: data.html,
        })
      }
    } else if (msg.type === 'H5_APPLET_UPDATE') {
      const data = msg.data
      if (
        h5AppletHost &&
        typeof data?.appId === 'string' &&
        typeof data.content === 'string' &&
        (data.patchType === 'replace' || data.patchType === 'css' || data.patchType === 'state')
      ) {
        h5AppletHost.update({
          appId: data.appId,
          patchType: data.patchType,
          content: data.content,
        })
      }
    } else if (msg.type === 'H5_APPLET_DESTROY') {
      const appId = typeof msg.data?.appId === 'string' ? msg.data.appId : ''
      if (h5AppletHost && appId) h5AppletHost.destroy(appId)
    } else if (msg.type === 'H5_APPLET_LIBRARY') {
      if (h5AppletHost && Array.isArray(msg.data?.items)) {
        const items = msg.data.items.flatMap((raw) => {
          if (!raw || typeof raw !== 'object') return []
          const item = raw as Record<string, unknown>
          const launchMode = item.launchMode
          if (
            typeof item.id !== 'string' ||
            typeof item.key !== 'string' ||
            typeof item.title !== 'string' ||
            typeof item.description !== 'string' ||
            typeof item.updatedAt !== 'string' ||
            (launchMode !== 'live_panel' && launchMode !== 'floating' && launchMode !== 'fullscreen' && launchMode !== 'overlay')
          ) {
            return []
          }
          return [{
            id: item.id,
            key: item.key,
            title: item.title,
            description: item.description,
            launchMode,
            updatedAt: item.updatedAt,
          }]
        })
        h5AppletHost.setLibrary(items)
      }
    } else if (msg.type === 'H5_APPLET_LAUNCH') {
      const key = typeof msg.data?.key === 'string' ? msg.data.key : ''
      if (h5AppletHost && key) h5AppletHost.launch(key)
    } else if (msg.type === 'H5_APPLET_GENERATION') {
      const status = msg.data?.status
      const title = typeof msg.data?.title === 'string' ? msg.data.title : '快应用'
      if (h5AppletHost && (status === 'started' || status === 'completed' || status === 'failed')) {
        h5AppletHost.setGenerationStatus({
          status,
          title,
          key: typeof msg.data?.key === 'string' ? msg.data.key : undefined,
          error: typeof msg.data?.error === 'string' ? msg.data.error : undefined,
        })
      }
    } else if (msg.type === 'TTS_STATUS') {
      ttsAvailable = !!msg.data?.available
      if (typeof msg.data?.enabled === 'boolean') ttsEnabled = msg.data.enabled
      if (!ttsEnabled) setVisualMouth(0)
      updateSpeakerBtn()
    } else if (msg.type === 'ASR_STATUS') {
      asrAvailable = !!msg.data?.available
      updateMicBtn()
      maybeAutoStartAsr()
    } else if (msg.type === 'CALL_AVAILABILITY') {
      callAvailabilityReasons = Array.isArray(msg.data?.reasons)
        ? (msg.data.reasons as unknown[]).filter((r): r is string => typeof r === 'string')
        : []
      updateMicBtn()
    } else if (msg.type === 'ASR_RESULT') {
      const text = typeof msg.data?.text === 'string' ? msg.data.text : ''
      if (callModeActive) {
        const trimmed = text.trim()
        if (trimmed && isSocketOpen(socket)) {
          sendSocketMessage(socket, 'CALL_USER_INPUT', { text: trimmed })
          setCallStatus('正在思考…')
        } else {
          setCallStatus('没听清，再说一遍～')
        }
      } else if (inputDictationAwaitingAsr) {
        acceptInputDictationTranscript(text)
        if (text.trim()) {
          rememberInputHistory(text.trim())
          touchConvActivity()
        }
      } else if (text.trim()) {
        rememberInputHistory(text.trim())
        if (userLineInput && !voiceMode) {
          userLineInput.value = text.trim()
          pushComposerDraft()
        }
        touchConvActivity()
      }
    } else if (msg.type === 'SLASH_COMPLETION') {
      const open = !!msg.data?.open
      const raw = msg.data?.items
      const next: SlashRow[] = []
      if (Array.isArray(raw)) {
        for (const it of raw) {
          if (!it || typeof it !== 'object') continue
          const o = it as Record<string, unknown>
          if (
            typeof o.id === 'string' &&
            typeof o.kind === 'string' &&
            typeof o.label === 'string' &&
            typeof o.desc === 'string' &&
            typeof o.insert === 'string'
          ) {
            next.push({
              id: o.id,
              kind: o.kind,
              label: o.label,
              desc: o.desc,
              insert: o.insert,
            })
          }
        }
      }
      const sig = next.map((r) => r.id).join('\0')
      if (sig !== slashSig) {
        slashSig = sig
        slashSel = 0
      }
      slashMenuOpenLive = open
      slashRows = next
      renderLiveSlashMenu()
    } else if (msg.type === 'CONFIG_OPEN') {
      const cwd = typeof msg.data?.cwd === 'string' ? msg.data.cwd : ''
      configPanel.open(cwd, msg.data?.config)
    } else if (msg.type === 'CONFIG_STATUS') {
      const ok = !!msg.data?.ok
      configPanel.setStatus(ok, typeof msg.data?.message === 'string' ? msg.data.message : '')
      if (ok) {
        configPanel.close('saved')
        requestAnimationFrame(() => scheduleDynamicWindowFit())
      }
    } else if (msg.type === 'VISION_CAPTURE_RESULT') {
      const requestId = typeof msg.data?.requestId === 'string' ? msg.data.requestId : ''
      if (!requestId || requestId !== activeCameraRequestId) return
      finishCameraCaptureUi()
      if (msg.data?.ok === true) {
        const vision = parseVisionAttachment(msg.data.vision)
        if (vision) {
          showPhotoPreview(requestId, vision)
          return
        }
      }
      console.warn('[liveui] 拍照失败:', msg.data?.error)
    } else if (msg.type === 'VISION_ATTACHMENT_CLEAR') {
      clearConfirmedPhotoUi(false)
    } else if (msg.type === 'ATTACHMENT_CLEAR') {
      attachedFiles = []
      renderAttachments()
    } else if (msg.type === 'AUDIO_CHUNK') {
      if (!minimalMode && ttsEnabled && msg.data) enqueueAudioChunk(msg.data)
    } else if (msg.type === 'AUDIO_RESET') {
      resetAudioQueue()
    } else if (msg.type === 'ACTION') {
      const em = msg.data?.expression
      if (em) applyLive2dExpression(em, msg.data?.intensity)
      const motion = msg.data?.motion
      if (motion && real2dAvatar) {
        real2dAvatar.triggerMotion(motion)
      }
      const gaze = msg.data?.gaze
      if (gaze && real2dAvatar) {
        real2dAvatar.setGaze(gaze)
      }
      if (motion && liveModel) {
        if (motion === 'shake') triggerPixiShake()
        else console.debug('[liveui] motion 指令（可扩展 motion 组映射）:', motion)
      } else if (motion === 'shake' && (expressionSprite || !real2dAvatar)) {
        triggerPixiShake()
      }
    } else if (msg.type === 'DEBUG_STATE') {
      debugOverlayEnabled = msg.data?.enabled === true
      if (typeof msg.data?.emotion === 'string') debugEmotion = msg.data.emotion
      if (typeof msg.data?.emotionIntensity === 'number' && Number.isFinite(msg.data.emotionIntensity)) {
        debugEmotionIntensity = msg.data.emotionIntensity
      }
      const relationship =
        msg.data?.relationship && typeof msg.data.relationship === 'object'
          ? msg.data.relationship as Record<string, unknown>
          : undefined
      renderDebugOverlay(relationship)
    } else if (msg.type === 'ASSISTANT_STREAM') {
      const fullRaw = typeof msg.data?.fullRaw === 'string' ? msg.data.fullRaw : ''
      if (msg.data?.reset) {
        assistantStreamState = createStreamLiveUiState()
        resetSpeechBubble()
      }
      const { displayText, newActions } = processAssistantStreamChunk(assistantStreamState, fullRaw)
      for (const a of newActions) {
        if (a.expression) applyLive2dExpression(a.expression)
      }
      setBubbleFromDisplayText(stripLiveUiKnownEmotionTagsEverywhere(displayText, streamManifestForStrip))
      if (msg.data?.done && bubbleTarget.trim()) {
        bubbleIsStreaming = false
        if (!minimalBubbleWaiting) scheduleBubbleDismiss()
      }
      touchConvActivity()
    } else if (msg.type === 'STATUS_PILL' && statusPill) {
      const label = typeof msg.data?.label === 'string' ? msg.data.label : '就绪'
      const v = msg.data?.variant
      const variant: LiveUiStatusVariant =
        v === 'ready' || v === 'busy' || v === 'warn' || v === 'loading' ? v : 'ready'
      const wasBusy = statusPillVariant === 'busy' || statusPillVariant === 'loading'
      statusPillVariant = variant
      llmBusy = variant === 'busy' || variant === 'loading'
      if (!llmBusy) interruptSent = false
      statusPill.textContent = label
      statusPill.className = `liveui-status-pill liveui-status-pill--${variant}`
      if (wasBusy && variant === 'ready' && bubbleTarget.trim()) {
        bubbleIsStreaming = false
        if (!minimalBubbleWaiting) scheduleBubbleDismiss()
      }
    }
  })

  userLineInput?.addEventListener('input', () => {
    inputHistoryIndex = inputHistory.length
    inputHistoryDraft = userLineInput.value
    pushComposerDraft()
    touchConvActivity()
  })

  userLineInput?.addEventListener('keydown', (ev) => {
    // Hold-space-to-dictate: 单按空格仍然是空格；按住 OS 触发 repeat
    // 后进入 inline 语音听写。
    if ((ev.key === ' ' || ev.code === 'Space') && !ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.isComposing) {
      if (inputDictationActive) {
        ev.preventDefault()
        return
      }
      if (!ev.repeat) {
        // 第一次按下：在 default action 插入空格前 snapshot value+selection
        if (userLineInput) {
          inputDictationPreValue = userLineInput.value
          inputDictationPreSelStart = userLineInput.selectionStart ?? userLineInput.value.length
          inputDictationPreSelEnd = userLineInput.selectionEnd ?? userLineInput.value.length
        }
      } else if (asrAvailable && !voiceMicAuto && !voiceMode) {
        // 长按 → 进入 inline 听写
        ev.preventDefault()
        void beginInputDictation()
        return
      }
    }
    if (slashMenuOpenLive && slashRows.length > 0) {
      if (ev.key === 'Tab') {
        ev.preventDefault()
        applySlashInsert()
        return
      }
      if (ev.key === 'ArrowUp') {
        ev.preventDefault()
        slashSel = (slashSel - 1 + slashRows.length) % slashRows.length
        renderLiveSlashMenu()
        return
      }
      if (ev.key === 'ArrowDown') {
        ev.preventDefault()
        slashSel = (slashSel + 1) % slashRows.length
        renderLiveSlashMenu()
        return
      }
    }
    if (!ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      if (ev.key === 'ArrowUp' && navigateInputHistory('up')) {
        ev.preventDefault()
        return
      }
      if (ev.key === 'ArrowDown' && navigateInputHistory('down')) {
        ev.preventDefault()
        return
      }
    }
    if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing) return
    // dictation 进行中（录音 / 等 ASR）禁止 Enter 提交，避免把 placeholder 当 prompt 发出去
    if (inputDictationActive || inputDictationAwaitingAsr) {
      ev.preventDefault()
      return
    }
    ev.preventDefault()
    const v = userLineInput.value.trimEnd()
    if (!v.trim()) return
    if (!isSocketOpen(socket)) return
    touchConvActivity()
    rememberInputHistory(v)
    void sendUserCommand(v)
    userLineInput.value = ''
    inputHistoryIndex = inputHistory.length
    inputHistoryDraft = ''
    pushComposerDraft()
    // 不再调用 refreshNormalWindowLayout()：textarea 已经固定尺寸（见 #liveui-user-line CSS），
    // 输入与提交都不会改变 dock 高度，因此不需要重排 avatar/figure/stage。
    // 这是从源头消除"提交触发 layout chain"竞争的关键——/showmemagic 链路上
    // 不再有任何机会去把 real2dStableStageHeight 推升到工作区高度。
  })

  userLineInput?.addEventListener('keyup', (ev) => {
    if (ev.key !== ' ' && ev.code !== 'Space') return
    if (!inputDictationActive) return
    ev.preventDefault()
    endInputDictation()
  })

  // 兜底：window keyup —— 即便 input 失去焦点或 readOnly 把事件吞了，
  // 也能从 window 拿到空格松开事件，防止 dictation 卡住。
  window.addEventListener('keyup', (ev) => {
    if (ev.key !== ' ' && ev.code !== 'Space') return
    if (!inputDictationActive) return
    endInputDictation()
  }, true)

  userLineInput?.addEventListener('blur', () => {
    if (inputDictationActive) {
      // 失去焦点视作取消，避免按住空格后切窗口卡住
      cancelInputDictation(null)
    }
  })

  wirePointerInteractions()

  setInterval(() => {
    if (!liveModel || statusPillVariant !== 'ready' || idleMotionBusy) return
    if (Date.now() - lastConvActivity < LIVE2D_IDLE.idleSeconds * 1000) return
    idleMotionBusy = true
    void (async () => {
      const pool = [...LIVE2D_IDLE.motionPool].sort(() => Math.random() - 0.5)
      for (const { group, index } of pool) {
        const ok = await liveModel.motion(group, index).catch(() => false)
        if (ok) break
      }
      idleMotionBusy = false
      touchConvActivity()
    })()
  }, LIVE2D_IDLE.pollIntervalMs)

  // ── 喇叭按钮：TTS 开关 ──
  const speakerBtn = document.getElementById('liveui-btn-speaker') as HTMLButtonElement | null
  const speakerIconOn = document.getElementById('liveui-speaker-icon-on')
  const speakerIconOff = document.getElementById('liveui-speaker-icon-off')

  const updateSpeakerBtn = (): void => {
    if (!speakerBtn) return
    speakerBtn.disabled = !ttsAvailable
    const on = !minimalMode && ttsEnabled && ttsAvailable
    speakerBtn.setAttribute('aria-pressed', String(on))
    speakerBtn.title = !ttsAvailable
      ? '语音回复：未配置 TTS（config.tts：mimo、minimax、moss_tts_nano、voxcpm 或 whisper）'
      : minimalMode
        ? '语音回复：极简模式中暂停'
      : on
        ? '语音回复：已开启'
        : '语音回复：已关闭'
    if (speakerIconOn) speakerIconOn.style.display = on ? '' : 'none'
    if (speakerIconOff) speakerIconOff.style.display = on ? 'none' : ''
  }

  speakerBtn?.addEventListener('click', () => {
    if (!ttsAvailable) return
    ttsEnabled = !ttsEnabled
    updateSpeakerBtn()
    sendSocketMessage(socket, 'TTS_TOGGLE', { enabled: ttsEnabled })
    if (!ttsEnabled) resetAudioQueue()
  })

  const minimalBtn = document.getElementById('liveui-btn-minimal') as HTMLButtonElement | null

  const updateMinimalBtn = (): void => {
    if (!minimalBtn) return
    minimalBtn.setAttribute('aria-pressed', String(minimalMode))
    minimalBtn.title = minimalMode ? '退出极简模式（Esc）' : '极简模式'
  }

  const setMinimalMode = (next: boolean): void => {
    minimalMode = next
    document.body.classList.toggle('liveui-minimal-mode', minimalMode)
    applyAssistantContentLayout(bubbleTarget)
    updateMinimalBtn()
    updateSpeakerBtn()
    if (minimalMode) {
      layoutFigureInStage()
      positionBubbleOverFigure()
    }
    syncMinimalWindowBounds = () => {
      if (!minimalMode) return
      const dock = document.getElementById('liveui-bottom-dock')
      const tools = document.getElementById('liveui-window-tools')
      const rects = [
        dock?.getBoundingClientRect(),
        tools?.getBoundingClientRect(),
        slashMenuEl && !slashMenuEl.hidden ? slashMenuEl.getBoundingClientRect() : undefined,
        speechBubble?.classList.contains('visible') ? speechBubble.getBoundingClientRect() : undefined,
      ].filter((r): r is DOMRect => !!r && r.width > 0 && r.height > 0)
      if (!rects.length) return
      const left = Math.min(...rects.map((r) => r.left))
      const right = Math.max(...rects.map((r) => r.right))
      const top = Math.min(...rects.map((r) => r.top))
      const bottom = Math.max(...rects.map((r) => r.bottom))
      const width = Math.ceil(right - left + 24)
      const height = Math.ceil(bottom - top + 16)
      windowManager.requestLayout({
        mode: 'minimal',
        reason: 'minimal-content-fit',
        open: true,
        bounds: { width, height },
      })
    }
    requestAnimationFrame(() => {
      if (!minimalMode) {
        windowManager.requestLayout({ mode: 'minimal', reason: 'minimal-mode-exit', open: false })
        refreshNormalWindowLayout()
        requestAnimationFrame(() => forceWindowInteractive())
        return
      }
      scheduleDynamicWindowFit()
    })
    if (!minimalMode && minimalBubbleWaiting) {
      startMinimalBubbleReading()
    }
    if (minimalMode) {
      resetReal2dCompactScaleState()
      resetAudioQueue()
      exitVoiceModeForMinimal()
      userLineInput?.focus()
    } else {
      resetReal2dCompactScaleState()
      maybeAutoStartAsr()
    }
  }

  minimalBtn?.addEventListener('click', () => {
    setMinimalMode(!minimalMode)
  })

  speechBubble?.addEventListener('click', () => {
    startMinimalBubbleReading()
  })

  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !minimalMode) return
    setMinimalMode(false)
  })

  document.getElementById('liveui-btn-config')?.addEventListener('click', () => {
    void sendUserCommand('/config')
  })

  document.getElementById('liveui-btn-exit')?.addEventListener('click', () => {
    void sendUserCommand('/exit')
  })

  const dragBtn = document.querySelector('.liveui-window-tool--drag') as HTMLElement | null
  dragBtn?.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return
    const api = window.infinitiLiveUi
    if (!api?.getWindowBounds || !api.setWindowPosition) return
    ev.preventDefault()
    ev.stopPropagation()
    dragBtn.setPointerCapture?.(ev.pointerId)
    dragBtn.classList.add('liveui-window-tool--dragging')
    document.body.classList.add('liveui-window-dragging')
    const startScreenX = ev.screenX
    const startScreenY = ev.screenY
    void api.getWindowBounds().then((bounds) => {
      if (!bounds) {
        dragBtn.classList.remove('liveui-window-tool--dragging')
        document.body.classList.remove('liveui-window-dragging')
        return
      }
      let dragging = true
      const move = (moveEv: PointerEvent): void => {
        if (!dragging) return
        if ((moveEv.buttons & 1) === 0) {
          end(moveEv)
          return
        }
        moveEv.preventDefault()
        api.setWindowPosition?.(
          bounds.x + moveEv.screenX - startScreenX,
          bounds.y + moveEv.screenY - startScreenY,
        )
      }
      const end = (endEv: PointerEvent): void => {
        if (!dragging) return
        dragging = false
        dragBtn.releasePointerCapture?.(endEv.pointerId)
        dragBtn.classList.remove('liveui-window-tool--dragging')
        document.body.classList.remove('liveui-window-dragging')
        window.removeEventListener('pointermove', move, true)
        window.removeEventListener('pointerup', end, true)
        window.removeEventListener('pointercancel', end, true)
      }
      window.addEventListener('pointermove', move, true)
      window.addEventListener('pointerup', end, true)
      window.addEventListener('pointercancel', end, true)
    }).catch(() => {
      dragBtn.classList.remove('liveui-window-tool--dragging')
      document.body.classList.remove('liveui-window-dragging')
    })
  })

  // ── 麦克风按钮：默认按住空格说话；`infiniti-agent live --auto` 使用连续 VAD 模式 ──
  const voiceMic = resolveVoiceMicWire(window.infinitiLiveUi?.voiceMic)
  // voiceMicAuto 在通话模式下会被临时翻成 true，所以不能 const
  let voiceMicAuto = voiceMic.mode === 'auto'
  /** 已进入说话段后略低于 speech 门限，避免字间弱音被当成静音 */
  const vadRmsRelease = Math.max(0.004, Math.min(voiceMic.speechRmsThreshold * 0.48, voiceMic.speechRmsThreshold - 1e-6))

  let asrAvailable = false
  let callAvailabilityReasons: string[] = []
  let callModeActive = false
  let voiceMode = false
  let micStream: MediaStream | null = null
  let mediaRecorder: MediaRecorder | null = null
  let micChunks: Blob[] = []
  let micAnalyser: AnalyserNode | null = null
  let micAudioCtx: AudioContext | null = null
  let vadRaf: number | undefined
  let isSpeaking = false
  let hasSpoken = false
  let silenceStart = 0
  let llmBusy = false
  let interruptSent = false
  let pttSpaceDown = false
  let pttRecording = false
  /**
   * Inline-in-input dictation: user holds Space inside #liveui-user-line.
   * - The single Space tap still inserts a normal space.
   * - When OS key-repeat fires, we roll the typed space(s) back, snapshot input
   *   state, open mic (if we don't own it yet), and stream MIC_AUDIO to agent.
   * - On release we wait for ASR_RESULT and splice the transcript at the
   *   original cursor position (no auto-send — user presses Enter).
   */
  let inputDictationActive = false
  let inputDictationAwaitingAsr = false
  let inputDictationOwnsMic = false
  let inputDictationPreValue = ''
  let inputDictationPreSelStart = 0
  let inputDictationPreSelEnd = 0
  let inputDictationAsrTimer: ReturnType<typeof setTimeout> | undefined

  /** 进入「在说话」前需连续满足频谱门控的帧数，抑制突发噪声误触 */
  let vadSpeechLikelyStreak = 0
  const VAD_SPEECH_START_FRAMES = 2

  const micBtn = document.getElementById('liveui-btn-mic') as HTMLButtonElement | null
  const micIconIdle = document.getElementById('liveui-mic-icon-idle')
  const micIconRecording = document.getElementById('liveui-mic-icon-recording')

  const updateMicBtn = (): void => {
    if (!micBtn) return
    micBtn.disabled = !asrAvailable
    micBtn.setAttribute('aria-pressed', String(voiceMode))
    const recordingNow = voiceMicAuto ? voiceMode : pttRecording
    micBtn.title = !asrAvailable
      ? '电话：未配置 ASR（需在 config 中配置 whisper 或 sherpa_onnx）'
      : voiceMode
        ? voiceMicAuto
          ? '通话中（自动语音）…点击挂断'
          : pttRecording
            ? '正在录音，松开发送识别'
            : '按住空格说话，松开发送；点击挂断'
        : voiceMicAuto
          ? '点击拨打：进入自动语音对话'
          : '点击拨打：开启语音输入（按住空格说话）'
    if (micIconIdle) micIconIdle.style.display = recordingNow ? 'none' : ''
    if (micIconRecording) micIconRecording.style.display = recordingNow ? '' : 'none'
  }

  const vadTimeDomain = new Float32Array(VAD_FFT_SIZE)
  const vadFreqBytes = new Uint8Array(VAD_FFT_SIZE / 2)

  /** 安静时语音带能量 EMA；用于简易「相对噪声底」判别 */
  let vadNoiseSpeechBandEma = 1e-10

  /**
   * 单帧：时域 RMS + 频谱人声特征（频段占比、平坦度、相对噪声底）。
   * 避免重复拉取 Analyser 数据，保证 RMS 与频谱同一时刻。
   */
  const computeVadFrame = (): { rms: number; spectralOk: boolean } => {
    if (!micAnalyser || !micAudioCtx) return { rms: 0, spectralOk: false }

    micAnalyser.getFloatTimeDomainData(vadTimeDomain)
    const n = micAnalyser.frequencyBinCount
    if (vadFreqBytes.length < n) return { rms: 0, spectralOk: false }
    micAnalyser.getByteFrequencyData(vadFreqBytes.subarray(0, n))
    const frame = computeVadFrameFromSamples({
      timeDomain: vadTimeDomain,
      freqBytes: vadFreqBytes.subarray(0, n),
      sampleRate: micAudioCtx.sampleRate,
      speechRmsThreshold: voiceMic.speechRmsThreshold,
      noiseSpeechBandEma: vadNoiseSpeechBandEma,
    })
    vadNoiseSpeechBandEma = frame.noiseSpeechBandEma
    return { rms: frame.rms, spectralOk: frame.spectralOk }
  }

  const sendRecordedAudio = (): void => {
    if (micChunks.length === 0) return
    const blob = new Blob(micChunks, { type: 'audio/webm' })
    micChunks = []
    // inline dictation 时把 transcribeOnly=true 一起送过去，agent 仅回识别结果、
    // 不再把它当 user line 自动喂给 LLM；用户改完手按 Enter 才发。
    const transcribeOnly = inputDictationAwaitingAsr || inputDictationActive
    const reader = new FileReader()
    reader.onloadend = () => {
      const base64 = (reader.result as string).split(',')[1]
      if (base64 && isSocketOpen(socket)) {
        console.debug(`[liveui] 发送录音: ${blob.size} bytes (transcribeOnly=${transcribeOnly})`)
        sendSocketMessage(socket, 'MIC_AUDIO', {
          audioBase64: base64,
          format: 'webm',
          ...(transcribeOnly ? { transcribeOnly: true } : {}),
        })
      }
    }
    reader.readAsDataURL(blob)
  }

  const startSegmentRecording = (): boolean => {
    if (!micStream || mediaRecorder?.state === 'recording') return false
    micChunks = []
    let mr: MediaRecorder
    try {
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'
      mr = new MediaRecorder(micStream, { mimeType: mime })
    } catch (e) {
      console.warn('[liveui] MediaRecorder 创建失败:', e)
      return false
    }
    mediaRecorder = mr
    mr.ondataavailable = (e) => {
      if (e.data.size > 0) micChunks.push(e.data)
    }
    mr.onstop = () => {
      sendRecordedAudio()
    }
    mr.start(250)
    console.debug('[liveui] 开始录音片段')
    return true
  }

  const stopSegmentRecording = (): void => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try {
        if (mediaRecorder.state === 'recording') mediaRecorder.requestData()
      } catch {
        /* ignore unsupported requestData timing */
      }
      try {
        mediaRecorder.stop()
      } catch (e) {
        console.warn('[liveui] MediaRecorder stop 失败:', e)
      }
      mediaRecorder = null
    }
  }

  const beginPushToTalk = (): void => {
    if (!voiceMode || voiceMicAuto || pttRecording || !micStream) return
    if (llmBusy && !interruptSent) {
      interruptSent = true
      sendSocketMessage(socket, 'INTERRUPT')
      resetAudioQueue()
    }
    if (!startSegmentRecording()) return
    pttRecording = true
    updateMicBtn()
  }

  /** 浮窗式 notice：value 为空时显示在 placeholder 上 ~3 秒后清掉。 */
  let inputNoticeToken = 0
  const showLiveNotice = (msg: string): void => {
    console.warn(`[liveui] ${msg}`)
    if (!userLineInput) return
    const myToken = ++inputNoticeToken
    userLineInput.placeholder = msg
    setTimeout(() => {
      if (inputNoticeToken === myToken && userLineInput) {
        userLineInput.placeholder = ''
      }
    }, 3000)
  }

  const cancelInputDictation = (reason: string | null): void => {
    if (!inputDictationActive && !inputDictationAwaitingAsr) return
    inputDictationActive = false
    inputDictationAwaitingAsr = false
    if (inputDictationAsrTimer) {
      clearTimeout(inputDictationAsrTimer)
      inputDictationAsrTimer = undefined
    }
    stopSegmentRecording()
    if (inputDictationOwnsMic) {
      if (micStream) {
        micStream.getTracks().forEach((t) => t.stop())
        micStream = null
      }
      if (micAudioCtx) {
        void micAudioCtx.close()
        micAudioCtx = null
        micAnalyser = null
      }
      inputDictationOwnsMic = false
    }
    if (userLineInput) {
      userLineInput.readOnly = false
      userLineInput.value = inputDictationPreValue
      try {
        userLineInput.setSelectionRange(inputDictationPreSelStart, inputDictationPreSelEnd)
      } catch {
        /* setSelectionRange can throw on disabled/non-focused inputs in rare cases */
      }
      pushComposerDraft()
      userLineInput.focus()
    }
    if (reason) showLiveNotice(reason)
  }

  const beginInputDictation = async (): Promise<void> => {
    if (!userLineInput || !asrAvailable || voiceMicAuto || inputDictationActive) return
    if (voiceMode) {
      // 用户已经在常规 PTT 语音模式里，不重复抢占；让现有 PTT 路径处理空格。
      return
    }
    // 已经在长按里，先把已被默认动作插入的空格回退到 pre 状态
    userLineInput.value = inputDictationPreValue
    try {
      userLineInput.setSelectionRange(inputDictationPreSelStart, inputDictationPreSelEnd)
    } catch {
      /* ignore */
    }

    inputDictationActive = true
    userLineInput.readOnly = true
    userLineInput.value = '🎤 听中～'

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1 } })
      if (!inputDictationActive) {
        // 用户已经释放，回退
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      micStream = stream
      inputDictationOwnsMic = true
      if (!startSegmentRecording()) throw new Error('MediaRecorder 启动失败')
    } catch (e) {
      console.warn('[liveui] inline dictation 麦克风获取失败:', e)
      cancelInputDictation(`听不到麦克风：${(e as Error).message}`)
    }
  }

  const endInputDictation = (): void => {
    if (!inputDictationActive) return
    inputDictationActive = false
    stopSegmentRecording()
    if (!userLineInput) {
      cancelInputDictation(null)
      return
    }
    if (!inputDictationOwnsMic && !mediaRecorder) {
      // 没真正录到，按取消处理
      cancelInputDictation('没录到，再试一次')
      return
    }
    inputDictationAwaitingAsr = true
    userLineInput.value = '🎤 识别中…'
    // 兜底：5 秒还没拿到结果就回退
    inputDictationAsrTimer = setTimeout(() => {
      if (inputDictationAwaitingAsr) cancelInputDictation('识别超时，再试一次')
    }, 5000)
  }

  const acceptInputDictationTranscript = (text: string): void => {
    if (!inputDictationAwaitingAsr) return
    inputDictationAwaitingAsr = false
    if (inputDictationAsrTimer) {
      clearTimeout(inputDictationAsrTimer)
      inputDictationAsrTimer = undefined
    }
    if (inputDictationOwnsMic) {
      if (micStream) {
        micStream.getTracks().forEach((t) => t.stop())
        micStream = null
      }
      if (micAudioCtx) {
        void micAudioCtx.close()
        micAudioCtx = null
        micAnalyser = null
      }
      inputDictationOwnsMic = false
    }
    if (!userLineInput) return
    userLineInput.readOnly = false
    const trimmed = text.trim()
    if (!trimmed) {
      userLineInput.value = inputDictationPreValue
      try {
        userLineInput.setSelectionRange(inputDictationPreSelStart, inputDictationPreSelEnd)
      } catch {
        /* ignore */
      }
      showLiveNotice('没听清，再试一次')
      pushComposerDraft()
      userLineInput.focus()
      return
    }
    const pre = inputDictationPreValue.slice(0, inputDictationPreSelStart)
    const post = inputDictationPreValue.slice(inputDictationPreSelEnd)
    const next = pre + trimmed + post
    userLineInput.value = next
    const cursor = pre.length + trimmed.length
    try {
      userLineInput.setSelectionRange(cursor, cursor)
    } catch {
      /* ignore */
    }
    pushComposerDraft()
    userLineInput.focus()
  }

  const endPushToTalk = (): void => {
    if (!pttRecording) return
    pttRecording = false
    stopSegmentRecording()
    updateMicBtn()
  }

  const vadLoop = (): void => {
    if (!voiceMode) return
    const { rms, spectralOk } = computeVadFrame()
    const now = Date.now()

    const rmsStart = rms > voiceMic.speechRmsThreshold
    const rmsHold = rms > vadRmsRelease

    const blockInterruptForTtsPlayback =
      voiceMic.suppressInterruptDuringTts && (audioPlaying || ttsActive)
    if (llmBusy && !interruptSent && !blockInterruptForTtsPlayback && rmsStart && spectralOk) {
      interruptSent = true
      console.debug('[liveui] 检测到语音打断，发送 INTERRUPT')
      sendSocketMessage(socket, 'INTERRUPT')
      resetAudioQueue()
    }

    let voiced = false
    if (isSpeaking) {
      voiced = rmsHold
    } else {
      if (rmsStart && spectralOk) vadSpeechLikelyStreak += 1
      else vadSpeechLikelyStreak = 0
      voiced = vadSpeechLikelyStreak >= VAD_SPEECH_START_FRAMES
    }

    if (voiced) {
      if (!isSpeaking) {
        isSpeaking = true
        hasSpoken = true
        if (!llmBusy) startSegmentRecording()
      }
      silenceStart = 0
    } else {
      if (isSpeaking) {
        if (silenceStart === 0) {
          silenceStart = now
        } else if (now - silenceStart >= voiceMic.silenceEndMs) {
          isSpeaking = false
          vadSpeechLikelyStreak = 0
          if (hasSpoken) {
            hasSpoken = false
            stopSegmentRecording()
          }
        }
      }
    }

    vadRaf = requestAnimationFrame(vadLoop)
  }

  const enterVoiceMode = async (): Promise<void> => {
    if (minimalMode) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1 },
      })
      if (minimalMode) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      micStream = stream
      micAudioCtx = new AudioContext()
      const source = micAudioCtx.createMediaStreamSource(stream)
      micAnalyser = micAudioCtx.createAnalyser()
      micAnalyser.fftSize = VAD_FFT_SIZE
      source.connect(micAnalyser)

      voiceMode = true
      isSpeaking = false
      hasSpoken = false
      silenceStart = 0
      interruptSent = false
      vadSpeechLikelyStreak = 0
      vadNoiseSpeechBandEma = 1e-10
      updateMicBtn()
      if (userLineInput) {
        userLineInput.disabled = true
        userLineInput.placeholder = voiceMicAuto
          ? '自动语音模式开启中…'
          : '按住空格说话，松开发送识别…'
      }
      if (voiceMicAuto) {
        vadRaf = requestAnimationFrame(vadLoop)
      }
    } catch (e) {
      console.warn('[liveui] 麦克风获取失败:', e)
    }
  }

  maybeAutoStartAsr = (): void => {
    if (minimalMode || !voiceMic.asrAutoEnabled || !asrAvailable || voiceMode) return
    void enterVoiceMode()
  }
  maybeAutoStartAsr()

  const exitVoiceMode = (): void => {
    voiceMode = false
    if (vadRaf) { cancelAnimationFrame(vadRaf); vadRaf = undefined }
    pttSpaceDown = false
    pttRecording = false
    stopSegmentRecording()
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop())
      micStream = null
    }
    if (micAudioCtx) {
      void micAudioCtx.close()
      micAudioCtx = null
      micAnalyser = null
    }
    isSpeaking = false
    hasSpoken = false
    updateMicBtn()
    if (userLineInput) {
      userLineInput.disabled = false
      userLineInput.placeholder = ''
    }
  }
  exitVoiceModeForMinimal = exitVoiceMode

  const finishPushToTalkIfNeeded = (): void => {
    if (!voiceMode || voiceMicAuto) return
    pttSpaceDown = false
    endPushToTalk()
  }

  window.addEventListener('keydown', (ev) => {
    if (!voiceMode || voiceMicAuto) return
    if (ev.key !== ' ' && ev.code !== 'Space') return
    if (ev.repeat || pttSpaceDown) return
    const target = ev.target as HTMLElement | null
    const tag = target?.tagName?.toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'button' || tag === 'select' || target?.isContentEditable) return
    ev.preventDefault()
    pttSpaceDown = true
    beginPushToTalk()
  }, true)

  window.addEventListener('keyup', (ev) => {
    if (!voiceMode || voiceMicAuto) return
    if (ev.key !== ' ' && ev.code !== 'Space') return
    ev.preventDefault()
    finishPushToTalkIfNeeded()
  }, true)

  window.addEventListener('blur', finishPushToTalkIfNeeded)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) finishPushToTalkIfNeeded()
  })

  // ── 通话模式 ──
  const callOverlay = document.getElementById('liveui-call-overlay') as HTMLElement | null
  const callStatusEl = document.getElementById('liveui-call-status') as HTMLElement | null
  const hangupBtn = document.getElementById('liveui-btn-hangup') as HTMLButtonElement | null

  const setCallStatus = (label: string): void => {
    if (callStatusEl) callStatusEl.textContent = label
  }

  const enterCallMode = async (): Promise<void> => {
    if (callModeActive) return
    if (!asrAvailable || !ttsAvailable) {
      const reasons = callAvailabilityReasons.length
        ? callAvailabilityReasons.join('\n')
        : '当前 ASR 或 TTS 不可用，无法通话。'
      try {
        if (window.infinitiLiveUi?.showMessage) {
          await window.infinitiLiveUi.showMessage({
            type: 'warning',
            title: '无法拨号',
            message: '通话模式需要 ASR 和 TTS 同时可用。',
            detail: reasons,
            buttons: ['知道了'],
          })
        } else {
          alert(`无法拨号：\n${reasons}`)
        }
      } catch {
        /* ignore dialog failure */
      }
      return
    }
    if (!isSocketOpen(socket)) {
      try { await window.infinitiLiveUi?.showMessage?.({ type: 'warning', title: '无法拨号', message: '尚未连上 agent，请稍后再试。' }) } catch { /* */ }
      return
    }

    callModeActive = true
    document.body.classList.add('liveui-call-mode')
    if (callOverlay) {
      callOverlay.hidden = false
      callOverlay.setAttribute('aria-hidden', 'false')
    }
    setCallStatus('正在拨号…')
    updateMicBtn()
    sendSocketMessage(socket, 'CALL_MODE_START')

    // 强制 auto-VAD（即便 cli 没传 --auto）
    // 临时把 voiceMicAuto 翻成 true，进入 voice mode 后 vadLoop 会自动跑
    voiceMicAuto = true
    voiceMic.mode = 'auto'
    await enterVoiceMode()
    if (voiceMode) {
      setCallStatus('在听你说…')
    } else {
      // 进入 voice mode 失败 → 回退
      callModeActive = false
      document.body.classList.remove('liveui-call-mode')
      if (callOverlay) {
        callOverlay.hidden = true
        callOverlay.setAttribute('aria-hidden', 'true')
      }
      updateMicBtn()
      try { await window.infinitiLiveUi?.showMessage?.({ type: 'warning', title: '无法拨号', message: '麦克风启动失败，请检查权限。' }) } catch { /* */ }
      sendSocketMessage(socket, 'CALL_MODE_END')
    }
  }

  const exitCallMode = (): void => {
    if (!callModeActive) return
    callModeActive = false
    document.body.classList.remove('liveui-call-mode')
    if (callOverlay) {
      callOverlay.hidden = true
      callOverlay.setAttribute('aria-hidden', 'true')
    }
    if (isSocketOpen(socket)) sendSocketMessage(socket, 'CALL_MODE_END')
    setCallStatus('通话结束')
    exitVoiceMode()
    updateMicBtn()
  }

  hangupBtn?.addEventListener('click', () => {
    hangupBtn.blur()
    exitCallMode()
  })

  micBtn?.addEventListener('click', () => {
    micBtn.blur()
    if (callModeActive) {
      exitCallMode()
      return
    }
    // 默认点击电话按钮 → 进入通话模式（需要 ASR + TTS 双就绪）
    void enterCallMode()
  })

  updateMicBtn()
  updateSpeakerBtn()

  // ── 相机按钮：单张拍照预览，确认后作为下一条消息附件 ──
  const visionBtn = document.getElementById('liveui-btn-vision') as HTMLButtonElement | null
  const attachBtn = document.getElementById('liveui-btn-attach') as HTMLButtonElement | null
  const attachThumb = document.getElementById('liveui-attachment-thumb') as HTMLImageElement | null
  const photoPreview = document.getElementById('liveui-photo-preview') as HTMLElement | null
  const photoPreviewImg = document.getElementById('liveui-photo-preview-img') as HTMLImageElement | null
  const photoCancelBtn = document.getElementById('liveui-photo-cancel') as HTMLButtonElement | null
  const photoConfirmBtn = document.getElementById('liveui-photo-confirm') as HTMLButtonElement | null
  const cameraCountdown = document.getElementById('liveui-camera-countdown') as HTMLElement | null
  const cameraCountdownIcon = document.getElementById('liveui-camera-countdown-icon') as SVGElement | null
  const cameraCountdownNumber = document.getElementById('liveui-camera-countdown-number') as HTMLElement | null
  const cameraPreviewStage = document.getElementById('liveui-camera-preview-stage') as HTMLElement | null
  const cameraStatus = document.getElementById('liveui-camera-status') as HTMLElement | null
  const cameraFlash = document.getElementById('liveui-camera-flash') as HTMLElement | null
  const attachmentList = document.getElementById('liveui-attachment-list')

  const readBlobBase64 = (blob: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(reader.error ?? new Error('读取附件失败'))
      reader.onload = () => {
        const s = String(reader.result ?? '')
        resolve(s.includes(',') ? s.split(',')[1] ?? '' : s)
      }
      reader.readAsDataURL(blob)
    })

  const renderAttachments = (): void => {
    if (!attachmentList) return
    attachmentList.replaceChildren()
    attachmentList.hidden = attachedFiles.length === 0
    for (const file of attachedFiles) {
      const chip = document.createElement('div')
      chip.className = 'liveui-attachment-chip'
      if (file.kind === 'image') {
        const img = document.createElement('img')
        img.src = `data:${file.mediaType};base64,${file.base64}`
        img.alt = ''
        chip.appendChild(img)
      } else {
        const icon = document.createElement('span')
        icon.textContent = attachmentChipLabel(file.mediaType, file.name)
        chip.appendChild(icon)
      }
      const name = document.createElement('span')
      name.className = 'liveui-attachment-chip-name'
      name.textContent = file.name
      chip.appendChild(name)
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'liveui-attachment-chip-remove'
      remove.textContent = '×'
      remove.addEventListener('click', (ev) => {
        ev.stopPropagation()
        attachedFiles = attachedFiles.filter((a) => a.id !== file.id)
        renderAttachments()
      })
      chip.appendChild(remove)
      attachmentList.appendChild(chip)
    }
    attachBtn?.classList.toggle('liveui-attach-btn--has-photo', attachedPhotoVision != null)
    attachBtn?.setAttribute('title', attachedFiles.length ? `已附加 ${attachedFiles.length} 个文件` : attachedPhotoVision ? '移除照片' : '附件')
  }

  const addAttachmentsFromPaths = async (paths: string[]): Promise<void> => {
    let imageCount = attachedFiles.filter((a) => a.kind === 'image').length
    for (const path of paths) {
      const mediaType = attachmentMediaType(path)
      if (!mediaType) continue
      const kind: ChatAttachment['kind'] = attachmentKindForMediaType(mediaType)
      if (kind === 'image') {
        imageCount += 1
        if (imageCount > 9) continue
      }
      const response = await fetch(filePathToUrl(path))
      const blob = await response.blob()
      if (blob.size > 12 * 1024 * 1024) continue
      const base64 = await readBlobBase64(blob)
      const text = shouldReadAttachmentText(mediaType) ? (await blob.text()).slice(0, 80_000) : undefined
      attachedFiles.push({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: filenameFromPath(path),
        mediaType,
        base64,
        size: blob.size,
        kind,
        capturedAt: new Date().toISOString(),
        ...(text ? { text } : {}),
      })
    }
    renderAttachments()
  }

  const updateCameraBtn = (): void => {
    if (!visionBtn) return
    visionBtn.disabled = cameraCapturing
    visionBtn.setAttribute('aria-busy', String(cameraCapturing))
    visionBtn.setAttribute('aria-pressed', 'false')
    visionBtn.title = cameraCapturing ? '正在拍照…' : '拍照'
  }

  let preparedCameraPreview: PreparedCameraCapture | null = null

  const setCameraStatus = (text: string): void => {
    if (cameraStatus) cameraStatus.textContent = text
  }

  const clearCameraPreviewStage = (): void => {
    cameraPreviewStage?.replaceChildren()
  }

  const closePreparedCameraPreview = (): void => {
    preparedCameraPreview?.close()
    preparedCameraPreview = null
    clearCameraPreviewStage()
  }

  const mountCameraPreview = (prepared: PreparedCameraCapture): void => {
    if (!cameraPreviewStage) return
    const video = prepared.video
    video.style.position = 'absolute'
    video.style.left = '0'
    video.style.top = '0'
    video.style.width = '100%'
    video.style.height = '100%'
    video.style.objectFit = 'cover'
    clearCameraPreviewStage()
    cameraPreviewStage.appendChild(video)
  }

  const setCameraCaptureMode = (open: boolean, reason: string): void => {
    const wasOpen = cameraCaptureOpen
    if (open && !wasOpen) {
      cameraReturnWindowSize = { width: window.innerWidth, height: window.innerHeight }
      pendingCameraCloseWindowSize = null
    } else if (!open && wasOpen) {
      pendingCameraCloseWindowSize = cameraReturnWindowSize
      cameraReturnWindowSize = null
    }
    cameraCaptureOpen = open
    document.body.classList.toggle('liveui-camera-capture-open', open)
    windowManager.requestLayout({ mode: 'camera', reason, open })
    if (cameraCountdown) {
      cameraCountdown.hidden = !open
      cameraCountdown.setAttribute('aria-hidden', String(!open))
    }
    if (open) {
      if (cameraCountdownIcon) cameraCountdownIcon.hidden = false
      if (cameraCountdownNumber) cameraCountdownNumber.textContent = ''
      setCameraStatus('准备摄像头')
      cancelDynamicWindowFit()
      return
    }
    if (cameraCountdownIcon) cameraCountdownIcon.hidden = false
    if (cameraCountdownNumber) cameraCountdownNumber.textContent = ''
    setCameraStatus('准备拍照')
    closePreparedCameraPreview()
    refreshCameraClosedLayout()
  }

  const finishCameraCaptureUi = (): void => {
    cameraCapturing = false
    activeCameraRequestId = ''
    if (cameraUiTimeout) {
      window.clearTimeout(cameraUiTimeout)
      cameraUiTimeout = undefined
    }
    setCameraCaptureMode(false, 'camera-finish')
    updateCameraBtn()
  }

  const setAttachedPhoto = (requestId: string, vision: LiveUiVisionAttachment): void => {
    attachedPhotoRequestId = requestId
    attachedPhotoVision = vision
    if (attachThumb) {
      attachThumb.src = photoDataUrl(vision)
      attachThumb.hidden = false
    }
    attachBtn?.classList.add('liveui-attach-btn--has-photo')
    attachBtn?.setAttribute('title', '移除照片')
    renderAttachments()
  }

  clearConfirmedPhotoUi = (notifyServer = true): void => {
    attachedPhotoRequestId = ''
    attachedPhotoVision = null
    if (attachThumb) {
      attachThumb.removeAttribute('src')
      attachThumb.hidden = true
    }
    attachBtn?.classList.remove('liveui-attach-btn--has-photo')
    attachBtn?.setAttribute('title', '附件')
    renderAttachments()
    if (notifyServer) {
      sendSocketMessage(socket, 'VISION_ATTACHMENT_CLEAR', {})
    }
  }

  const hidePhotoPreview = (notifyServer = true): void => {
    const requestId = previewPhotoRequestId
    previewPhotoRequestId = ''
    previewPhotoVision = null
    if (photoPreview) photoPreview.hidden = true
    if (photoPreviewImg) photoPreviewImg.removeAttribute('src')
    if (notifyServer && requestId) {
      sendSocketMessage(socket, 'VISION_CAPTURE_CANCEL', { requestId })
    }
  }

  const showPhotoPreview = (requestId: string, vision: LiveUiVisionAttachment): void => {
    previewPhotoRequestId = requestId
    previewPhotoVision = vision
    if (photoPreviewImg) photoPreviewImg.src = photoDataUrl(vision)
    if (photoPreview) photoPreview.hidden = false
    window.infinitiLiveUi?.setIgnoreMouseEvents?.(false)
  }

  const animatePhotoIntoAttachment = (source: HTMLImageElement, done: () => void): void => {
    if (!attachBtn) {
      done()
      return
    }
    const from = source.getBoundingClientRect()
    const to = attachBtn.getBoundingClientRect()
    const clone = document.createElement('img')
    clone.className = 'liveui-photo-fly'
    clone.src = source.src
    clone.style.left = `${from.left}px`
    clone.style.top = `${from.top}px`
    clone.style.width = `${from.width}px`
    clone.style.height = `${from.height}px`
    clone.style.borderRadius = '10px'
    document.body.appendChild(clone)
    window.requestAnimationFrame(() => {
      clone.style.left = `${to.left + 3}px`
      clone.style.top = `${to.top + 3}px`
      clone.style.width = `${Math.max(1, to.width - 6)}px`
      clone.style.height = `${Math.max(1, to.height - 6)}px`
      clone.style.borderRadius = '6px'
      clone.style.opacity = '0.96'
    })
    window.setTimeout(() => {
      clone.remove()
      done()
    }, 760)
  }

  const confirmPhotoPreview = (): void => {
    if (!previewPhotoVision || !previewPhotoRequestId) return
    const requestId = previewPhotoRequestId
    const vision = previewPhotoVision
    sendSocketMessage(socket, 'VISION_CAPTURE_CONFIRM', { requestId, vision })
    if (photoPreviewImg?.src) {
      animatePhotoIntoAttachment(photoPreviewImg, () => setAttachedPhoto(requestId, vision))
    } else {
      setAttachedPhoto(requestId, vision)
    }
    hidePhotoPreview(false)
  }

  const triggerCameraFlash = async (): Promise<void> => {
    if (!cameraFlash) return
    cameraFlash.classList.remove('liveui-camera-flash--on')
    void cameraFlash.offsetWidth
    cameraFlash.classList.add('liveui-camera-flash--on')
    await delay(120)
  }

  const runCameraCountdown = async (): Promise<void> => {
    if (cameraCountdownIcon) cameraCountdownIcon.hidden = true
    try {
      for (const n of ['3', '2', '1']) {
        if (cameraCountdownNumber) cameraCountdownNumber.textContent = n
        setCameraStatus('保持微笑')
        await delay(720)
      }
      if (cameraCountdownNumber) cameraCountdownNumber.textContent = ''
      setCameraStatus('拍摄中')
      await triggerCameraFlash()
    } finally {
      if (cameraCountdownIcon) cameraCountdownIcon.hidden = false
    }
  }

  const requestCameraPhoto = async (): Promise<void> => {
    if (cameraCapturing) return
    hidePhotoPreview(true)
    cameraCapturing = true
    const requestId = `photo-${Date.now()}-${++cameraCaptureSeq}`
    activeCameraRequestId = requestId
    updateCameraBtn()
    cameraUiTimeout = window.setTimeout(() => {
      if (activeCameraRequestId !== requestId) return
      console.warn('[liveui] 拍照请求超时，已恢复相机按钮')
      finishCameraCaptureUi()
    }, 30_000)
    try {
      setCameraCaptureMode(true, 'camera-countdown')
      const locationPromise = getCurrentLocation(1200)
      preparedCameraPreview = await prepareCameraCapture()
      mountCameraPreview(preparedCameraPreview)
      if (activeCameraRequestId !== requestId) return
      setCameraStatus('准备拍照')
      await runCameraCountdown()
      if (activeCameraRequestId !== requestId || !preparedCameraPreview) return
      const location = await locationPromise
      const vision = preparedCameraPreview.capture(location)
      finishCameraCaptureUi()
      showPhotoPreview(requestId, vision)
    } catch (e) {
      console.warn(`[liveui] 拍照失败: ${describeCameraError(e)}`)
      if (activeCameraRequestId === requestId) finishCameraCaptureUi()
    }
  }

  visionBtn?.addEventListener('click', () => {
    visionBtn.blur()
    void requestCameraPhoto()
  })
  photoCancelBtn?.addEventListener('click', () => hidePhotoPreview(true))
  photoConfirmBtn?.addEventListener('click', confirmPhotoPreview)
  attachBtn?.addEventListener('click', () => {
    attachBtn.blur()
    void (async () => {
      const paths = await window.infinitiLiveUi?.selectAttachments?.()
      if (paths?.length) {
        try {
          await addAttachmentsFromPaths(paths)
        } catch (e) {
          console.warn('[liveui] 附件读取失败:', e)
        }
        return
      }
      if (attachedPhotoVision && !attachedFiles.length) clearConfirmedPhotoUi(true)
    })()
  })

  updateCameraBtn()
  renderAttachments()

  app.ticker.add(() => {
    if (!liveModel && !expressionSprite) {
      const t = performance.now() / 1000
      face.scale.set(1 + Math.sin(t * 2.2) * 0.012)
    }
  })

  // ── macOS 透明窗口：动态切换鼠标穿透 ──
  const setIgnore = window.infinitiLiveUi?.setIgnoreMouseEvents
  if (setIgnore) {
    let windowIgnoring = true
    forceWindowInteractive = () => {
      windowIgnoring = false
      windowManager.setInteractive(true)
    }

    const isOverInteractive = (ex: number, ey: number): boolean => {
      if (configPanelOpen || inboxController.isOpen) return true
      const dom = document.elementFromPoint(ex, ey)
      if (
        dom &&
        (dom.closest('#liveui-control-bar') ||
          dom.closest('#liveui-slash-menu') ||
          dom.closest('#speech-bubble') ||
          dom.closest('#liveui-config-panel') ||
          dom.closest('#liveui-photo-preview') ||
          dom.closest('#liveui-inbox') ||
          dom.closest('#liveui-h5-runtime') ||
          dom.closest('.liveui-h5-launcher'))
      ) {
        return true
      }
      if (liveModel) {
        const b = liveModel.getBounds()
        if (ex >= b.x && ex <= b.x + b.width && ey >= b.y && ey <= b.y + b.height) return true
      } else if (expressionSprite) {
        const b = expressionSprite.getBounds()
        if (ex >= b.x && ex <= b.x + b.width && ey >= b.y && ey <= b.y + b.height) return true
      } else {
        const dx = ex - face.x
        const dy = ey - face.y
        if (dx * dx + dy * dy <= FACE_RADIUS * FACE_RADIUS) return true
      }
      return false
    }

    document.addEventListener('mousemove', (e) => {
      const shouldCapture = isOverInteractive(e.clientX, e.clientY)
      if (shouldCapture && windowIgnoring) {
        windowIgnoring = false
        setIgnore(false)
      } else if (!shouldCapture && !windowIgnoring) {
        windowIgnoring = true
        setIgnore(true, { forward: true })
      }
    })
  }
}

void bootstrap()
