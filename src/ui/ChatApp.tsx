import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { basename, isAbsolute, relative, resolve, join } from 'node:path'
import { copyFile } from 'node:fs/promises'
import { Box, Text, useApp, useInput, useWindowSize } from 'ink'
import chokidar from 'chokidar'
import type { InfinitiConfig } from '../config/types.js'
import { loadSkillsForCwd, skillsToSystemBlock } from '../skills/loader.js'
import {
  loadAgentPromptDocs,
  buildAgentSystemPrompt,
} from '../prompt/loadProjectPrompt.js'
import { buildSystemWithMemory } from '../prompt/systemBuilder.js'
import { LIVE_UI_ASSISTANT_EXPRESSION_NUDGE } from '../prompt/liveUiExpressionNudge.js'
import {
  buildLiveUiExpressionNudgeFromManifest,
  tryReadSpriteExpressionManifestSync,
} from '../liveui/spriteExpressionManifest.js'
import { runToolLoop } from '../llm/runLoop.js'
import type { PersistedMessage } from '../llm/persisted.js'
import { oneShotTextCompletion } from '../llm/oneShotCompletion.js'
import { saveSession, loadSession } from '../session/file.js'
import { localInboxDir, localSkillsDir } from '../paths.js'
import type { McpManager } from '../mcp/manager.js'
import { loadConfig, saveProjectConfig } from '../config/io.js'
import { formatChatError } from '../utils/formatError.js'
import { EditHistory } from '../session/editHistory.js'
import {
  buildSlashItems,
  filterSlashItems,
  type SlashItem,
} from './slashCompletions.js'
import { parseSpeakCommandLine } from '../liveui/speakCommandLine.js'
import type { LiveUiInteractionKind, LiveUiSession } from '../liveui/wsSession.js'
import type { LiveUiFileAttachment, LiveUiStatusVariant, LiveUiVisionAttachment } from '../liveui/protocol.js'
import { enqueueSnapPhotoJob } from '../snap/asyncSnap.js'
import { enqueueSeedanceVideoJob, seedanceReferenceImagesFromLiveInputs } from '../video/asyncVideo.js'
import { enqueueAvatarGenJob } from '../avatar/asyncAvatarGen.js'
import { avatarGenReferenceImagesFromLiveInputs } from '../avatar/real2dAvatarGen.js'
import { listInboxMessages, markInboxMessageRead, type InboxMessage } from '../inbox/store.js'
import {
  advanceScheduleTask,
  dueScheduleTasks,
  failScheduleTask,
  formatScheduleTask,
  loadScheduleStore,
  saveScheduleStore,
  type ScheduleTask,
} from '../schedule/store.js'
import {
  collectNewTtsSegments,
  splitTtsSegments,
} from '../tts/streamSegments.js'
import {
  createStreamLiveUiState,
  processAssistantStreamChunk,
  stripLiveUiKnownEmotionTagsEverywhere,
  stripLiveUiTagsFromMessages,
} from '../liveui/emotionParse.js'
import { SubconsciousAgent } from '../subconscious/agent.js'
import {
  finalizeQueuedMediaCommand,
  parseQueuedMediaCommand,
  queuedMediaEmptyPromptMessage,
  queuedMediaNotice,
  runQueuedMediaCommand,
} from './queuedMediaCommand.js'
import { parseChatSlashCommand } from './chatSlashCommands.js'
import {
  handleClearSlashCommand,
  handleConfigSlashCommand,
  handleCompactSlashCommand,
  handleDebugSlashCommand,
  handleExitSlashCommand,
  handleHelpSlashCommand,
  handleInboxSlashCommand,
  handleMemorySlashCommand,
  handlePermissionSlashCommand,
  handleReloadSlashCommand,
  handleRollSlashCommand,
  handleScheduleSlashCommand,
  handleSpeakSlashCommand,
  handleUndoSlashCommand,
} from './chatCommandHandlers.js'
import { maybeStartAutoCompaction, mergeCompactedPrefixWithLatest } from './chatAutoCompaction.js'
import { StableTextInput } from './StableTextInput.js'

/**
 * Live 下 TTS 用的「干净正文」：与流式 onTextDelta 一致，先 `processAssistantStreamChunk` 得 `displayText`
 *（仅由当前 `full` 决定，与流式 state 无关），再 `stripLiveUiKnownEmotionTagsEverywhere`。
 * 收尾补播必须用本函数从 `assistantRaw` 得到 `clean`，才能与流式 TTS cursor 对齐。
 */
function ttsDisplayCleanForLiveUi(
  assistantRaw: string,
  manifest: Parameters<typeof stripLiveUiKnownEmotionTagsEverywhere>[1],
): string {
  const { displayText } = processAssistantStreamChunk(createStreamLiveUiState(), assistantRaw)
  return stripLiveUiKnownEmotionTagsEverywhere(displayText, manifest)
}

type Props = {
  config: InfinitiConfig
  mcp: McpManager
  dangerouslySkipPermissions?: boolean
  liveUi?: LiveUiSession | null
  onConfigReload?: (config: InfinitiConfig) => Promise<void>
}

const STREAM_DEBOUNCE_MS = 80
const SLASH_MENU_MAX_ROWS = 10
const SUBCONSCIOUS_HEARTBEAT_MS = 60_000
const LLM_PROVIDERS = new Set(['anthropic', 'openai', 'gemini', 'minimax', 'openrouter'])

function subconsciousHeartbeatMs(config: InfinitiConfig): number {
  const ms = config.liveUi?.subconsciousHeartbeatMs
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return SUBCONSCIOUS_HEARTBEAT_MS
  return Math.max(5000, Math.min(3600000, Math.round(ms)))
}

function inboxMessageToLiveUiItem(m: InboxMessage) {
  return {
    id: m.id,
    createdAt: m.createdAt,
    subject: m.subject,
    body: m.body,
    attachments: m.attachments,
  }
}

async function polishSnapQueuedReply(config: InfinitiConfig, prompt: string, jobId: string): Promise<string> {
  const fallback =
    `好呀，我去把这张画面慢慢生成出来。你可以先继续聊，等照片好了我会把它放进你的邮箱，小信封亮起来的时候点开就能看见。`
  try {
    const out = await oneShotTextCompletion({
      config,
      maxOutTokens: 500,
      system:
        '你是 Infiniti Agent 的日常对话人格。请只输出中文正文，不要标题，不要列表，不要任务 ID，不要像系统通知。用户刚发出 /snap 图片生成命令；你的回复要像普通聊天里自然接话，亲近、轻松、简短。表达：你会在后台生成图片；用户可以继续聊天；完成后会放进你的邮箱，小信封亮起即可查看。',
      user: `用户想生成的图片：${prompt}\n内部任务 ID（不要输出）：${jobId}\n请给出一句或两句自然口语回复。参考但不要照抄：\n\n${fallback}`,
    })
    return out.trim() || fallback
  } catch {
    return fallback
  }
}

async function polishVideoQueuedReply(config: InfinitiConfig, prompt: string, jobId: string): Promise<string> {
  const fallback =
    `好，我把这个视频任务交给 Seedance 在后台生成。你可以继续聊天，等视频完成后我会下载到本地并放进你的邮箱，小信封亮起来就能看见。`
  try {
    const out = await oneShotTextCompletion({
      config,
      maxOutTokens: 500,
      system:
        '你是 Infiniti Agent 的日常对话人格。请只输出中文正文，不要标题，不要列表，不要任务 ID，不要像系统通知。用户刚发出 /video 或 /seedance 视频生成命令；你的回复要像普通聊天里自然接话，亲近、轻松、简短。表达：你会在后台生成视频；用户可以继续聊天；完成后会下载到本地并放进你的邮箱，小信封亮起即可查看。',
      user: `用户想生成的视频：${prompt}\n内部任务 ID（不要输出）：${jobId}\n请给出一句或两句自然口语回复。参考但不要照抄：\n\n${fallback}`,
    })
    return out.trim() || fallback
  } catch {
    return fallback
  }
}

async function polishAvatarGenQueuedReply(config: InfinitiConfig, prompt: string, jobId: string): Promise<string> {
  const fallback =
    `好，我把这套 Real2D 表情 PNG 放到后台生成。你可以继续聊，等 exp01 到 exp06 和 exp_open 都好了，我会把它们放进你的邮箱，小信封亮起来就能查看。`
  try {
    const out = await oneShotTextCompletion({
      config,
      maxOutTokens: 500,
      system:
        '你是 Infiniti Agent 的日常对话人格。请只输出中文正文，不要标题，不要列表，不要任务 ID，不要像系统通知。用户刚发出 /avatargen real2d 表情集生成命令；你的回复要像普通聊天里自然接话，亲近、轻松、简短。表达：你会在后台生成 exp01 到 exp06 和 exp_open；用户可以继续聊天；完成后会放进你的邮箱，小信封亮起即可查看。',
      user: `用户对 Real2D 表情集的要求：${prompt}\n内部任务 ID（不要输出）：${jobId}\n请给出一句或两句自然口语回复。参考但不要照抄：\n\n${fallback}`,
    })
    return out.trim() || fallback
  } catch {
    return fallback
  }
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

function stripTransientVision(messages: PersistedMessage[]): PersistedMessage[] {
  return messages.map((m) => {
    if (m.role !== 'user' || (!m.vision && !m.attachments?.length)) return m
    const { vision: _vision, attachments: _attachments, ...rest } = m
    return rest
  })
}

function attachmentSummary(attachments: LiveUiFileAttachment[]): string {
  if (!attachments.length) return ''
  const imageCount = attachments.filter((a) => a.kind === 'image').length
  const docCount = attachments.length - imageCount
  const parts = [
    imageCount ? `${imageCount} 张图片` : '',
    docCount ? `${docCount} 个文档` : '',
  ].filter(Boolean)
  return parts.length ? `\n\n[已附带${parts.join('、')}]` : ''
}

function validateConfigPanelSave(raw: unknown): asserts raw is InfinitiConfig {
  if (!raw || typeof raw !== 'object') {
    throw new Error('配置格式无效')
  }
  const cfg = raw as { llm?: unknown }
  if (!cfg.llm || typeof cfg.llm !== 'object') {
    throw new Error('缺少 llm 配置块')
  }
  const llm = cfg.llm as Record<string, unknown>
  const profiles = llm.profiles && typeof llm.profiles === 'object'
    ? llm.profiles as Record<string, unknown>
    : undefined
  const defaultName = typeof llm.default === 'string' ? llm.default : undefined
  const selected =
    defaultName && profiles && profiles[defaultName] && typeof profiles[defaultName] === 'object'
      ? profiles[defaultName] as Record<string, unknown>
      : llm
  const provider = selected.provider
  if (typeof provider !== 'string' || !LLM_PROVIDERS.has(provider)) {
    throw new Error('默认 LLM provider 无效')
  }
  for (const key of ['baseUrl', 'model', 'apiKey']) {
    if (typeof selected[key] !== 'string' || !selected[key].trim()) {
      throw new Error(`默认 LLM profile 缺少 ${key}`)
    }
  }
}

export function ChatApp({
  config: initialConfig,
  mcp,
  dangerouslySkipPermissions,
  liveUi = null,
  onConfigReload,
}: Props): React.ReactElement {
  const { exit } = useApp()
  const { columns, rows } = useWindowSize()
  const [config, setConfig] = useState(initialConfig)
  const [cwd, setCwd] = useState(process.cwd())
  const [messages, setMessages] = useState<PersistedMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [skillsEpoch, setSkillsEpoch] = useState(0)
  const [promptEpoch, setPromptEpoch] = useState(0)
  const [sessionReady, setSessionReady] = useState(false)
  const [streamText, setStreamText] = useState('')
  const streamTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const streamLiveUiRef = useRef(createStreamLiveUiState())
  const ttsCursorRef = useRef(0)
  const [liveUiConnected, setLiveUiConnected] = useState(false)
  const [debugOverlayEnabled, setDebugOverlayEnabled] = useState(false)
  const liveUiConnectedRef = useRef(false)
  const debugOverlayEnabledRef = useRef(false)
  liveUiConnectedRef.current = liveUiConnected
  debugOverlayEnabledRef.current = debugOverlayEnabled
  const editHistoryRef = useRef(new EditHistory())
  const [slashIndex, setSlashIndex] = useState(0)
  const busyRef = useRef(false)
  busyRef.current = busy
  const abortRef = useRef<AbortController | null>(null)
  const liveUiInteractionCooldownRef = useRef(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [compacting, setCompacting] = useState(false)
  const compactingRef = useRef(false)
  compactingRef.current = compacting
  const lastAutoCompactionRef = useRef<{
    compactedBase: PersistedMessage[]
    originalBase: PersistedMessage[]
  } | null>(null)
  const busySubtextRef = useRef<string | null>(null)
  const thinkingTextRef = useRef('')
  const lastStreamDeltaAtRef = useRef<number | null>(null)
  const busyStartRef = useRef<number>(0)
  const [statusLine, setStatusLine] = useState('')
  const [thinkingSnap, setThinkingSnap] = useState('')
  const subconsciousRef = useRef<SubconsciousAgent | null>(null)
  const scheduleRunningRef = useRef(false)
  const messagesRef = useRef<PersistedMessage[]>([])
  messagesRef.current = messages

  const slashItems = useMemo(
    () => buildSlashItems(mcp),
    [mcp, config],
  )

  const slashFiltered = useMemo(
    () => filterSlashItems(slashItems, input),
    [slashItems, input],
  )

  const expressionManifest = useMemo(
    () => tryReadSpriteExpressionManifestSync(cwd, config.liveUi),
    [cwd, config.liveUi, promptEpoch],
  )

  const visibleStreamText = useMemo(() => {
    if (!streamText) return null
    const lastNl = streamText.lastIndexOf('\n')
    return lastNl >= 0 ? streamText.substring(0, lastNl + 1) : null
  }, [streamText])

  const slashMenuOpen =
    sessionReady &&
    !busy &&
    input.startsWith('/') &&
    !input.includes(' ') &&
    !input.includes('\n')

  useEffect(() => {
    setSlashIndex(0)
  }, [input])

  useEffect(() => {
    if (!busy) {
      setStatusLine('')
      setThinkingSnap('')
      busySubtextRef.current = null
      thinkingTextRef.current = ''
      return
    }
    busyStartRef.current = Date.now()
    lastStreamDeltaAtRef.current = null
    const id = setInterval(() => {
      const elapsed = Math.floor((Date.now() - busyStartRef.current) / 1000)
      const last = lastStreamDeltaAtRef.current
      const stall = last ? Math.floor((Date.now() - last) / 1000) : 0
      const sub = busySubtextRef.current ?? '请求中（Anthropic/OpenAI/Gemini 均走流式 SSE）…'
      const elapsedPart = elapsed > 0 ? ` · 已 ${elapsed}s` : ''
      const stallPart = stall >= 12 && last != null ? ` · ${stall}s 无新字` : ''
      setStatusLine(`${sub}${elapsedPart}${stallPart}`)
      if (thinkingTextRef.current) {
        setThinkingSnap(thinkingTextRef.current)
      }
    }, 1000)
    return () => clearInterval(id)
  }, [busy])

  useEffect(() => {
    if (!liveUi) {
      setLiveUiConnected(false)
      return
    }
    return liveUi.onConnectionChange(setLiveUiConnected)
  }, [liveUi])

  useEffect(() => {
    const agent = new SubconsciousAgent(config, cwd, liveUi)
    subconsciousRef.current = agent
    void agent.start().then(() => {
      if (debugOverlayEnabledRef.current) void agent.setDebugOverlayEnabled(true)
    })
    const heartbeatMs = subconsciousHeartbeatMs(config)
    const id = setInterval(() => {
      void agent
        .heartbeat(new Date(), {
          allowProactiveGreeting: Boolean(liveUi && liveUiConnectedRef.current && !busyRef.current),
        })
        .then((greeting) => {
          if (!greeting || !liveUi || busyRef.current) return
          liveUi.sendAssistantStream(greeting, true, true)
          if (liveUi.hasTts) {
            const clean = ttsDisplayCleanForLiveUi(greeting, expressionManifest)
            liveUi.resetAudio()
            for (const seg of splitTtsSegments(clean)) {
              liveUi.enqueueTts(seg)
            }
          }
          setMessages((prev) => {
            const next: PersistedMessage[] = [...prev, { role: 'assistant', content: greeting }]
            void saveSession(cwd, next)
            return next
          })
        })
        .catch((e: unknown) => {
          if (process.env.INFINITI_AGENT_DEBUG === '1') {
            setError(formatChatError(e))
          }
        })
    }, heartbeatMs)
    return () => {
      clearInterval(id)
      if (subconsciousRef.current === agent) {
        subconsciousRef.current = null
      }
    }
  }, [config, cwd, expressionManifest, liveUi])

  useEffect(() => {
    void subconsciousRef.current?.setDebugOverlayEnabled(debugOverlayEnabled)
  }, [debugOverlayEnabled])

  useInput(
    (_ch, key) => {
      if (!slashMenuOpen) {
        return
      }
      const list = slashFiltered
      if (key.tab) {
        if (list.length === 0) {
          return
        }
        const idx =
          ((slashIndex % list.length) + list.length) % list.length
        const item = list[idx]!
        const ins = item.insert.endsWith(' ') ? item.insert : `${item.insert} `
        setInput(ins)
        return
      }
      if (key.upArrow) {
        if (list.length === 0) {
          return
        }
        setSlashIndex((i) => (i - 1 + list.length) % list.length)
        return
      }
      if (key.downArrow) {
        if (list.length === 0) {
          return
        }
        setSlashIndex((i) => (i + 1) % list.length)
      }
    },
    { isActive: slashMenuOpen && !liveUi },
  )

  const flushStream = useCallback((full: string) => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current)
    }
    streamTimerRef.current = setTimeout(() => {
      setStreamText(full)
    }, STREAM_DEBOUNCE_MS)
  }, [])

  const resetStream = useCallback(() => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current)
      streamTimerRef.current = undefined
    }
    streamLiveUiRef.current = createStreamLiveUiState()
    liveUi?.mouth.reset()
    setStreamText('')
  }, [liveUi])


  useEffect(() => {
    void (async () => {
      try {
        const s = await loadSession(cwd)
        if (s?.messages?.length) {
          setMessages(s.messages)
        }
      } finally {
        setSessionReady(true)
      }
    })()
  }, [])

  useEffect(() => {
    const w = chokidar.watch(localSkillsDir(cwd), {
      ignoreInitial: true,
      persistent: true,
    })
    const bump = (): void => {
      setSkillsEpoch((n) => n + 1)
    }
    w.on('add', bump).on('change', bump).on('unlink', bump)
    return () => {
      void w.close()
    }
  }, [cwd])

  useEffect(() => {
    const paths = [
      join(cwd, 'SOUL.md'),
      join(cwd, 'INFINITI.md'),
      join(cwd, 'CLAUDE.md'),
      join(cwd, '.claude', 'CLAUDE.md'),
      join(cwd, 'AGENT.md'),
      join(cwd, 'AGENTS.md'),
    ]
    const seDir = config.liveUi?.spriteExpressions?.dir?.trim()
    if (seDir) paths.push(join(cwd, seDir, 'expressions.json'))
    const w = chokidar.watch(paths, {
      ignoreInitial: true,
      persistent: true,
    })
    const bump = (): void => {
      setPromptEpoch((n) => n + 1)
    }
    w.on('add', bump).on('change', bump).on('unlink', bump)
    return () => {
      void w.close()
    }
  }, [cwd, config.liveUi?.spriteExpressions?.dir])

  const buildSystem = useCallback(async (query?: string): Promise<string> => {
    void skillsEpoch
    void promptEpoch
    const base = await buildSystemWithMemory(config, cwd, subconsciousRef.current ?? undefined, query)
    if (!liveUi) return base
    const m = tryReadSpriteExpressionManifestSync(cwd, config.liveUi)
    const nudge = m ? buildLiveUiExpressionNudgeFromManifest(m) : LIVE_UI_ASSISTANT_EXPRESSION_NUDGE
    return `${base}\n\n${nudge}`
  }, [config, cwd, skillsEpoch, promptEpoch, liveUi])

  const deliverAssistantText = useCallback(
    (content: string, opts: { appendToSession?: boolean } = {}) => {
      if (liveUi) {
        liveUi.sendAssistantStream(content, true, true)
        if (liveUi.hasTts) {
          const clean = ttsDisplayCleanForLiveUi(content, expressionManifest)
          liveUi.resetAudio()
          for (const seg of splitTtsSegments(clean)) {
            liveUi.enqueueTts(seg)
          }
        }
      }
      if (opts.appendToSession) {
        setMessages((prev) => {
          const next: PersistedMessage[] = [...prev, { role: 'assistant', content }]
          messagesRef.current = next
          void saveSession(cwd, next)
          return next
        })
      }
    },
    [cwd, expressionManifest, liveUi],
  )

  const deliverLocalCommandExchange = useCallback(
    (userLine: string, assistantText: string) => {
      deliverAssistantText(assistantText)
      void subconsciousRef.current?.observeUserInput(userLine)
      void subconsciousRef.current?.observeAssistantOutput(assistantText)
      setMessages((prev) => {
        const next: PersistedMessage[] = [
          ...prev,
          { role: 'user', content: userLine },
          { role: 'assistant', content: assistantText },
        ]
        messagesRef.current = next
        void saveSession(cwd, next)
        return next
      })
    },
    [cwd, deliverAssistantText],
  )

  const runScheduleTask = useCallback(
    async (task: ScheduleTask): Promise<void> => {
      const baseMessages = messagesRef.current
      const scheduledUser: PersistedMessage = {
        role: 'user',
        content: `[计划任务 ${task.id}] ${task.prompt}`,
      }
      void subconsciousRef.current?.observeUserInput(scheduledUser.content)
      const system = await buildSystem(task.prompt)
      const { messages: outRaw } = await runToolLoop({
        config,
        system,
        messages: [...baseMessages, scheduledUser],
        cwd,
        mcp,
        skipPermissions: dangerouslySkipPermissions,
        editHistory: editHistoryRef.current,
        memoryCoordinator: subconsciousRef.current ?? undefined,
      })
      const out = liveUi ? stripLiveUiTagsFromMessages(outRaw, expressionManifest) : outRaw
      const displayOut = stripTransientVision(out)
      setMessages(displayOut)
      messagesRef.current = displayOut
      await saveSession(cwd, displayOut)
      const lastMsg = outRaw[outRaw.length - 1]
      if (lastMsg?.role === 'assistant' && typeof lastMsg.content === 'string' && lastMsg.content) {
        void subconsciousRef.current?.observeAssistantOutput(lastMsg.content)
        deliverAssistantText(lastMsg.content)
      } else {
        deliverAssistantText(`计划任务已执行：${task.prompt}`, { appendToSession: true })
      }
    },
    [buildSystem, config, cwd, dangerouslySkipPermissions, deliverAssistantText, expressionManifest, liveUi, mcp],
  )

  const processDueSchedules = useCallback(async () => {
    if (!sessionReady) return
    if (scheduleRunningRef.current || busyRef.current) return
    scheduleRunningRef.current = true
    try {
      let store = await loadScheduleStore(cwd)
      const due = dueScheduleTasks(store, new Date())
      for (const task of due) {
        if (busyRef.current) break
        try {
          setNotice(`执行计划任务：${task.prompt}`)
          await runScheduleTask(task)
          store = await loadScheduleStore(cwd)
          store.tasks = store.tasks.map((t) => t.id === task.id ? advanceScheduleTask(t, new Date()) : t)
          await saveScheduleStore(cwd, store)
          setNotice(`计划任务完成：${task.prompt}`)
          setTimeout(() => setNotice(null), 5000)
        } catch (e: unknown) {
          const msg = formatChatError(e)
          store = await loadScheduleStore(cwd)
          store.tasks = store.tasks.map((t) => t.id === task.id ? failScheduleTask(t, msg, new Date()) : t)
          await saveScheduleStore(cwd, store)
          setError(`计划任务失败：${msg}`)
        }
      }
    } finally {
      scheduleRunningRef.current = false
    }
  }, [cwd, runScheduleTask, sessionReady])

  useEffect(() => {
    const heartbeatMs = subconsciousHeartbeatMs(config)
    void processDueSchedules()
    const id = setInterval(() => {
      void processDueSchedules()
    }, heartbeatMs)
    return () => clearInterval(id)
  }, [config, processDueSchedules])

  const reloadAll = useCallback(async () => {
    try {
      const next = await loadConfig(cwd)
      setConfig(next)
      await mcp.stop()
      await mcp.start(next)
      setError(null)
    } catch (e: unknown) {
      setError(formatChatError(e))
    }
  }, [mcp])

  const handleSubmit = useCallback(
    async (line: string, vision?: LiveUiVisionAttachment) => {
      const raw = line.trimEnd()
      if (!raw.trim()) {
        return
      }
      if (!sessionReady) {
        return
      }

      const speakText = parseSpeakCommandLine(raw)
      if (speakText !== undefined) {
        handleSpeakSlashCommand(speakText, liveUi, { setError, setInput })
        return
      }

      if (busyRef.current) return

      const slashCommand = parseChatSlashCommand(raw)
      if (slashCommand) {
        switch (slashCommand.kind) {
          case 'exit':
            await handleExitSlashCommand(cwd, messages, exit)
            return
          case 'clear':
            await handleClearSlashCommand(cwd, messages, { setMessages, setInput })
            return
          case 'reload':
            await handleReloadSlashCommand(reloadAll, { setInput })
            return
          case 'config':
            handleConfigSlashCommand(cwd, config, liveUi, {
              setError,
              setInput,
              setNotice,
              clearNoticeLater: (ms) => setTimeout(() => setNotice(null), ms),
            })
            return
          case 'debug': {
            handleDebugSlashCommand(
              liveUi,
              debugOverlayEnabled,
              setDebugOverlayEnabled,
              subconsciousRef.current,
              {
                setError,
                setInput,
                setNotice,
                clearNoticeLater: (ms) => setTimeout(() => setNotice(null), ms),
              },
            )
            return
          }
          case 'scheduleList': {
            await handleScheduleSlashCommand(cwd, raw, slashCommand, {
              setError,
              setInput,
              deliverLocalCommandExchange,
            })
            return
          }
          case 'scheduleClear': {
            await handleScheduleSlashCommand(cwd, raw, slashCommand, {
              setError,
              setInput,
              deliverLocalCommandExchange,
            })
            return
          }
          case 'scheduleRemove': {
            await handleScheduleSlashCommand(cwd, raw, slashCommand, {
              setError,
              setInput,
              deliverLocalCommandExchange,
            })
            return
          }
          case 'scheduleAdd': {
            await handleScheduleSlashCommand(cwd, raw, slashCommand, {
              setError,
              setInput,
              deliverLocalCommandExchange,
            })
            return
          }
          case 'memory':
            handleMemorySlashCommand({ setError, setInput })
            return
          case 'inbox': {
            await handleInboxSlashCommand(cwd, slashCommand, liveUi, {
              setInput,
              setNotice,
              clearNoticeLater: (ms) => setTimeout(() => setNotice(null), ms),
            })
            return
          }
          case 'lastEmail': {
            await handleInboxSlashCommand(cwd, slashCommand, liveUi, {
              setInput,
              setNotice,
              clearNoticeLater: (ms) => setTimeout(() => setNotice(null), ms),
            })
            return
          }
          case 'help':
            handleHelpSlashCommand({ setError, setInput })
            return
          case 'compact':
            handleCompactSlashCommand(cwd, config, messages, slashCommand, subconsciousRef.current, {
              setError,
              setInput,
              setNotice,
              setMessages,
              setCompacting,
              clearNoticeLater: (ms) => setTimeout(() => setNotice(null), ms),
            })
            return
          case 'permission': {
            handlePermissionSlashCommand(slashCommand, dangerouslySkipPermissions, {
              setInput,
              setNotice,
              clearNoticeLater: (ms) => setTimeout(() => setNotice(null), ms),
            })
            return
          }
          case 'undo':
            await handleUndoSlashCommand(cwd, editHistoryRef.current, {
              setError,
              setInput,
              setNotice,
              clearNoticeLater: (ms) => setTimeout(() => setNotice(null), ms),
            })
            return
          case 'roll': {
            await handleRollSlashCommand(cwd, messages, slashCommand, {
              setError,
              setInput,
              setNotice,
              setMessages,
              clearNoticeLater: (ms) => setTimeout(() => setNotice(null), ms),
            })
            return
          }
        }
      }
      const mediaCommand = parseQueuedMediaCommand(raw)
      if (mediaCommand) {
        const prompt = mediaCommand.prompt
        if (!prompt) {
          const msg = queuedMediaEmptyPromptMessage(mediaCommand)
          setInput('')
          setError(msg)
          if (mediaCommand.kind === 'avatargen') {
            liveUi?.sendAssistantStream(msg, true, true)
          }
          return
        }
        if (busyRef.current) return
        setError(null)
        setNotice(queuedMediaNotice(mediaCommand.kind))
        setInput('')
        try {
          const content = await runQueuedMediaCommand({
            command: mediaCommand,
            getVision: () => vision ?? liveUi?.consumePendingVisionAttachment(),
            getFileAttachments: () => liveUi?.consumePendingFileAttachments() ?? [],
            clearVisionAttachment: () => liveUi?.clearVisionAttachment(),
            clearFileAttachments: () => liveUi?.clearFileAttachments(),
            avatarReferences: avatarGenReferenceImagesFromLiveInputs,
            videoReferences: seedanceReferenceImagesFromLiveInputs,
            enqueueAvatar: (queuedPrompt, referenceImages) =>
              enqueueAvatarGenJob(cwd, config, queuedPrompt, referenceImages),
            enqueueVideo: (queuedPrompt, referenceImages) =>
              enqueueSeedanceVideoJob(cwd, config, queuedPrompt, referenceImages),
            enqueueSnap: (queuedPrompt, queuedVision) =>
              enqueueSnapPhotoJob(cwd, config, queuedPrompt, queuedVision),
            polishAvatar: (queuedPrompt, jobId) => polishAvatarGenQueuedReply(config, queuedPrompt, jobId),
            polishVideo: (queuedPrompt, jobId) => polishVideoQueuedReply(config, queuedPrompt, jobId),
            polishSnap: (queuedPrompt, jobId) => polishSnapQueuedReply(config, queuedPrompt, jobId),
          })
          await finalizeQueuedMediaCommand({
            cwd,
            messages,
            rawCommand: raw,
            assistantContent: content,
            liveUi,
            cleanForTts: (text) => ttsDisplayCleanForLiveUi(text, expressionManifest),
            observeAssistantOutput: (text) => subconsciousRef.current?.observeAssistantOutput(text),
            saveSession,
            setMessages,
            setNotice,
            clearNoticeLater: (ms) => setTimeout(() => setNotice(null), ms),
          })
        } catch (e: unknown) {
          const msg = formatChatError(e)
          setError(msg)
          if (mediaCommand.kind === 'avatargen') {
            liveUi?.sendAssistantStream(msg, true, true)
          }
          setNotice(null)
        }
        return
      }

      setBusy(true)
      setError(null)
      busySubtextRef.current = '等待模型响应（首包/跨境 API 可能较慢）…'
      resetStream()
      thinkingTextRef.current = ''
      setThinkingSnap('')
      const ac = new AbortController()
      abortRef.current = ac
      const userLine = raw

      let baseMessages = messages
      maybeStartAutoCompaction({
        cwd,
        config,
        messages: baseMessages,
        controller: subconsciousRef.current,
        compacting: compactingRef.current,
        onCompactedBase: (compactedBase, originalBase) => {
          lastAutoCompactionRef.current = { compactedBase, originalBase }
        },
        ui: {
          setCompacting,
          setNotice,
          setError,
          setBusy,
          getMessages: () => messagesRef.current,
          setMessages,
          clearNoticeLater: (ms) => setTimeout(() => setNotice(null), ms),
        },
      })

      const turnVision = vision ?? liveUi?.consumePendingVisionAttachment()
      const turnAttachments = liveUi?.consumePendingFileAttachments() ?? []
      void subconsciousRef.current?.observeUserInput(userLine)

      const nextMsgs: PersistedMessage[] = [
        ...baseMessages,
        {
          role: 'user',
          content: `${userLine}${turnVision ? '\n\n[已附带视觉快照]' : ''}${attachmentSummary(turnAttachments)}`,
          ...(turnVision ? { vision: turnVision } : {}),
          ...(turnAttachments.length ? { attachments: turnAttachments } : {}),
        },
      ]
      if (turnVision) liveUi?.clearVisionAttachment()
      else if (turnAttachments.length) liveUi?.clearFileAttachments()
      setMessages(nextMsgs)
      setInput('')
      try {
        const system = await buildSystem(userLine)
        const { messages: outRaw } = await runToolLoop({
          config,
          system,
          messages: nextMsgs,
          cwd,
          mcp,
          skipPermissions: dangerouslySkipPermissions,
          editHistory: editHistoryRef.current,
          memoryCoordinator: subconsciousRef.current ?? undefined,
          signal: ac.signal,
          onToolDispatch: (name) => {
            busySubtextRef.current = `执行工具：${name}…`
          },
          stream: {
            onStreamReset: () => {
              resetStream()
              thinkingTextRef.current = ''
              setThinkingSnap('')
              lastStreamDeltaAtRef.current = null
              busySubtextRef.current = '等待模型响应（多轮工具之间会重新请求）…'
              liveUi?.sendAssistantStream('', true)
              ttsCursorRef.current = 0
              if (liveUi?.hasTts) {
                liveUi.resetAudio()
              }
            },
            onTextDelta: (_delta, full) => {
              lastStreamDeltaAtRef.current = Date.now()
              busySubtextRef.current =
                'SSE 流式中（久无新字时：可能在生成 tool 调用或网络慢）…'
              if (liveUi) {
                liveUi.sendAssistantStream(full, false)
                processAssistantStreamChunk(streamLiveUiRef.current, full)
                const clean = ttsDisplayCleanForLiveUi(full, expressionManifest)
                liveUi.mouth.onDisplayText(clean)
                flushStream(clean)
                if (liveUi.hasTts) {
                  const next = collectNewTtsSegments(clean, ttsCursorRef.current)
                  for (const seg of next.segments) {
                    liveUi.enqueueTts(seg)
                  }
                  ttsCursorRef.current = next.cursor
                }
              } else {
                flushStream(full)
              }
            },
            onToolUseStart: (toolName) => {
              lastStreamDeltaAtRef.current = Date.now()
              busySubtextRef.current =
                `模型正在生成 ${toolName} 调用参数（SSE 仍在传输中）…`
            },
            onToolExecStart: (toolName) => {
              lastStreamDeltaAtRef.current = Date.now()
              busySubtextRef.current = `正在执行工具 ${toolName}…`
            },
            onThinkingDelta: (_delta, full) => {
              lastStreamDeltaAtRef.current = Date.now()
              busySubtextRef.current = '模型正在深度思考…'
              thinkingTextRef.current = full
            },
          },
        })
        const out = liveUi ? stripLiveUiTagsFromMessages(outRaw, expressionManifest) : outRaw
        if (liveUi?.hasTts) {
          const lastMsg = outRaw[outRaw.length - 1]
          if (lastMsg?.role === 'assistant' && typeof lastMsg.content === 'string' && lastMsg.content) {
            void subconsciousRef.current?.observeAssistantOutput(lastMsg.content)
            const clean = ttsDisplayCleanForLiveUi(lastMsg.content, expressionManifest)
            const next = collectNewTtsSegments(clean, ttsCursorRef.current, { final: true })
            for (const seg of next.segments) {
              liveUi.enqueueTts(seg)
            }
            ttsCursorRef.current = next.cursor
          }
        } else {
          const lastMsg = outRaw[outRaw.length - 1]
          if (lastMsg?.role === 'assistant' && typeof lastMsg.content === 'string' && lastMsg.content) {
            void subconsciousRef.current?.observeAssistantOutput(lastMsg.content)
          }
        }
        const displayOutRaw = stripTransientVision(out)
        const compactedForThisTurn = lastAutoCompactionRef.current
        const displayOut = compactedForThisTurn
          ? mergeCompactedPrefixWithLatest(
              compactedForThisTurn.compactedBase,
              compactedForThisTurn.originalBase,
              displayOutRaw,
            )
          : displayOutRaw
        if (compactedForThisTurn) lastAutoCompactionRef.current = null
        setMessages(displayOut)
        await saveSession(cwd, displayOut)
      } catch (e: unknown) {
        if (!ac.signal.aborted) {
          setError(formatChatError(e))
        }
      } finally {
        abortRef.current = null
        busySubtextRef.current = null
        resetStream()
        setBusy(false)
      }
    },
    [
      buildSystem,
      config,
      cwd,
      debugOverlayEnabled,
      exit,
      expressionManifest,
      flushStream,
      liveUi,
      mcp,
      messages,
      reloadAll,
      resetStream,
      sessionReady,
    ],
  )

  useEffect(() => {
    if (!liveUi) return
    return liveUi.onUserLine((line) => {
      void handleSubmit(line)
    })
  }, [liveUi, handleSubmit])

  useEffect(() => {
    if (!liveUi) return
    return liveUi.onUserComposer(setInput)
  }, [liveUi])

  useEffect(() => {
    if (!liveUi) return
    liveUi.sendSlashCompletion(
      slashMenuOpen,
      slashFiltered.map((i) => ({
        id: i.id,
        kind: i.kind,
        label: i.label,
        desc: i.desc,
        insert: i.insert,
      })),
    )
  }, [liveUi, slashMenuOpen, slashFiltered])

  const refreshLiveInbox = useCallback(async () => {
    if (!liveUi) return
    const unread = await listInboxMessages(cwd, { unreadOnly: true, limit: 5 })
    liveUi.sendInboxUpdate(unread.map(inboxMessageToLiveUiItem))
  }, [cwd, liveUi])

  useEffect(() => {
    if (!liveUi) return
    let stopped = false
    const tick = async () => {
      try {
        await refreshLiveInbox()
      } catch {
        /* inbox refresh is best-effort UI sync */
      }
    }
    void tick()
    const timer = setInterval(() => {
      if (!stopped) void tick()
    }, 2500)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [liveUi, refreshLiveInbox])

  useEffect(() => {
    if (!liveUi) return
    return liveUi.onInboxMarkRead((ids) => {
      void (async () => {
        await Promise.all(ids.map((id) => markInboxMessageRead(cwd, id).catch(() => null)))
        await refreshLiveInbox()
      })()
    })
  }, [cwd, liveUi, refreshLiveInbox])

  useEffect(() => {
    if (!liveUi) return
    return liveUi.onInboxSaveAs((sourcePath, destinationPath) => {
      void (async () => {
        try {
          const inboxRoot = localInboxDir(cwd)
          const source = resolve(sourcePath)
          const dest = resolve(destinationPath)
          const knownInboxAttachment = (await listInboxMessages(cwd)).some((m) =>
            m.attachments.some((a) => resolve(a.path) === source),
          )
          if (!isPathInside(inboxRoot, source) && !knownInboxAttachment) {
            throw new Error('只能另存你的邮箱里的附件')
          }
          await copyFile(source, dest)
          liveUi.sendInboxSaveResult(true, `已另存为 ${basename(dest)}`)
        } catch (e: unknown) {
          liveUi.sendInboxSaveResult(false, formatChatError(e))
        }
      })()
    })
  }, [cwd, liveUi])

  useEffect(() => {
    if (!liveUi) return
    return liveUi.onInterrupt(() => {
      const ac = abortRef.current
      if (ac && !ac.signal.aborted) {
        ac.abort()
        liveUi.resetAudio()
      }
    })
  }, [liveUi])

  useEffect(() => {
    if (!liveUi) return
    return liveUi.onConfigSave((nextConfig) => {
      void (async () => {
        try {
          validateConfigPanelSave(nextConfig)
          await saveProjectConfig(cwd, nextConfig)
          const next = await loadConfig(cwd)
          setConfig(next)
          await mcp.stop()
          await mcp.start(next)
          if (onConfigReload) {
            await onConfigReload(next)
          }
          setError(null)
          setNotice('配置已保存到项目 .infiniti-agent/config.json；当前 Live 设置已热重载')
          setTimeout(() => setNotice(null), 7000)
          liveUi.sendConfigStatus(true, '已保存并热重载。')
        } catch (e: unknown) {
          const msg = formatChatError(e)
          setError(msg)
          liveUi.sendConfigStatus(false, msg)
        }
      })()
    })
  }, [cwd, liveUi, mcp, onConfigReload])

  useEffect(() => {
    if (!liveUi) return
    const prompts: Record<LiveUiInteractionKind, string> = {
      head_pat:
        '（刚才用户摸了摸你的头。请用一两句中文轻声回应；句首必须加合适的表情标签，例如 [Blush]。）',
      body_poke:
        '（刚才用户戳了戳你。请用一两句中文假装有点被冒犯又好笑；句首加表情标签，例如 [Angry] 或 [Thinking]。）',
    }
    return liveUi.onInteraction((kind) => {
      if (busyRef.current) return
      const now = Date.now()
      if (now - liveUiInteractionCooldownRef.current < 5000) return
      liveUiInteractionCooldownRef.current = now
      void handleSubmit(prompts[kind])
    })
  }, [liveUi, handleSubmit])

  useEffect(() => {
    if (!liveUi) return
    let label = '就绪'
    let variant: LiveUiStatusVariant = 'ready'
    if (!sessionReady) {
      label = '加载中…'
      variant = 'loading'
    } else if (busy) {
      label = '处理中…'
      variant = 'busy'
    } else if (compacting) {
      label = '就绪 · 后台压缩'
      variant = 'warn'
    } else if (!liveUiConnected) {
      label = '就绪 · 渲染未连'
      variant = 'warn'
    } else {
      label = '就绪'
      variant = 'ready'
    }
    liveUi.sendStatusPill(label, variant)
  }, [liveUi, sessionReady, compacting, busy, liveUiConnected])

  const visibleCount = Math.max(4, rows - 14)
  const visible = messages.slice(-visibleCount)
  const permLabel = dangerouslySkipPermissions
    ? ' · ⚠ 跳过安全评估'
    : ''
  const thinkLabel =
    config.llm.provider === 'anthropic' && (config.thinking?.mode ?? 'adaptive') !== 'disabled'
      ? ` · think:${config.thinking?.mode ?? 'adaptive'}`
      : ''
  const profileCount = config.llm.profiles ? Object.keys(config.llm.profiles).length : 0
  const profileLabel = profileCount > 1 ? ` · ${profileCount} profiles` : ''
  const meta = `${config.llm.provider} · ${config.llm.model}${thinkLabel}${profileLabel}${permLabel}`

  return (
    <Box flexDirection="column" width="100%" height={rows} overflow="hidden" paddingX={1}>
      <Box
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
        paddingY={0}
        marginBottom={1}
        flexDirection="column"
        flexShrink={0}
      >
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color="cyan">
            ∞ Infiniti Agent
          </Text>
          <Text dimColor>SSE</Text>
        </Box>
        <Text dimColor>
          {meta}
        </Text>
        {liveUi ? (
          <Box flexDirection="row" flexWrap="wrap">
            <Text dimColor>LiveUI </Text>
            <Text color={liveUiConnected ? 'green' : 'yellow'}>
              {liveUiConnected ? '● 渲染已连接' : '○ 等待渲染'}
            </Text>
            <Text dimColor>{` · ws://127.0.0.1:${liveUi.port}`}</Text>
            {liveUi.hasTts ? (
              <Text color="cyan">{' · TTS ✓'}</Text>
            ) : (
              <Text dimColor>{' · TTS ✗'}</Text>
            )}
          </Box>
        ) : null}
        <Text dimColor wrap="truncate">
          cwd: {cwd}
        </Text>
      </Box>

      <Text dimColor>
        输入 / 补全命令与工具 · ↑↓ Tab · SOUL/INFINITI/CLAUDE/AGENT 热重载
      </Text>

      {notice ? (
        <Box marginY={1} paddingX={1}>
          <Text dimColor>{notice}</Text>
        </Box>
      ) : null}

      {error ? (
        <Box marginY={1} borderStyle="round" borderColor="red" paddingX={1}>
          <Text color="red">{error}</Text>
        </Box>
      ) : null}

      <Box
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        paddingY={1}
        marginTop={1}
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        overflow="hidden"
        minHeight={6}
        justifyContent="flex-end"
      >
        {visible.map((m, i) => (
          <MessageLine key={`${i}-${m.role}`} m={m} />
        ))}
        {thinkingSnap && !visibleStreamText ? (
          <Box
            flexDirection="column"
            marginTop={1}
            borderStyle="single"
            borderLeft
            borderLeftColor="yellow"
            paddingLeft={1}
          >
            <Text bold color="yellow">
              💭 Thinking…
            </Text>
            <Text dimColor wrap="wrap">
              {thinkingSnap.length > 600
                ? `…${thinkingSnap.slice(-600)}`
                : thinkingSnap}
            </Text>
          </Box>
        ) : null}
        {visibleStreamText ? (
          <Box
            flexDirection="column"
            marginTop={1}
            borderStyle="single"
            borderLeft
            borderLeftColor="magenta"
            paddingLeft={1}
          >
            <Text bold color="magenta">
              Assistant · 流式
            </Text>
            <Text dimColor wrap="wrap">
              {visibleStreamText}
            </Text>
          </Box>
        ) : null}
      </Box>

      {!sessionReady ? (
        <Box marginTop={1} flexShrink={0}>
          <Text dimColor>正在加载会话…</Text>
        </Box>
      ) : null}
      {busy ? (
        <Box marginTop={1} flexShrink={0}>
          <Text color="yellow">
            {compacting
              ? '◆ 正在压缩会话历史（非流式）…'
              : `◆ ${statusLine || '请求中（Anthropic/OpenAI/Gemini 均走流式 SSE）…'}`}
          </Text>
        </Box>
      ) : null}

      {slashMenuOpen && !liveUi ? (
        <SlashCompletePanel
          items={slashFiltered}
          selectedIndex={slashIndex}
        />
      ) : null}

      <Box
        marginTop={1}
        borderStyle="single"
        borderColor="cyan"
        paddingX={1}
        height={3}
        flexShrink={0}
        overflow="hidden"
      >
        {liveUi ? (
          <Text dimColor wrap="wrap">
            输入已移至桌面 Live 窗口底部；此处不再接收键盘输入（仍显示状态与历史）。斜杠命令在窗口输入框输入 / 可调出补全（Tab 写入 · ↑↓ 选择），例如 /help /clear。
          </Text>
        ) : (
          <StableTextInput
            value={input}
            focus={!busy && sessionReady}
            onChange={setInput}
            onSubmit={(v) => {
              void handleSubmit(v)
            }}
            placeholder="输入…"
            columns={Math.max(1, columns - 6)}
            nativeCursorY={Math.max(0, rows - 1)}
          />
        )}
      </Box>
    </Box>
  )
}

const SlashCompletePanel = React.memo(function SlashCompletePanel({
  items,
  selectedIndex,
}: {
  items: SlashItem[]
  selectedIndex: number
}): React.ReactElement {
  const total = items.length
  const sel = total > 0 ? ((selectedIndex % total) + total) % total : 0
  let start = 0
  if (total > SLASH_MENU_MAX_ROWS) {
    start = Math.max(
      0,
      Math.min(sel - Math.floor(SLASH_MENU_MAX_ROWS / 2), total - SLASH_MENU_MAX_ROWS),
    )
  }
  const visible = items.slice(start, start + SLASH_MENU_MAX_ROWS)

  return (
    <Box
      marginTop={1}
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      paddingY={1}
    >
      <Text bold color="yellow">
        / 补全
      </Text>
      <Text dimColor>
        ↑↓ 选择 · Tab 写入 · 共 {total} 项
        {total > SLASH_MENU_MAX_ROWS
          ? `（显示 ${start + 1}-${start + visible.length}）`
          : ''}
      </Text>
      {total === 0 ? (
        <Text dimColor>无匹配项，继续输入或退格修改</Text>
      ) : (
        visible.map((item, i) => {
          const globalIdx = start + i
          const active = globalIdx === sel
          const kindTag = item.kind === 'command' ? '命令' : '工具'
          return (
            <Box key={`${item.kind}-${item.id}-${globalIdx}`} flexDirection="row">
              <Text color={active ? 'cyan' : 'gray'} bold={active}>
                {active ? '› ' : '  '}
              </Text>
              <Text color={active ? 'cyan' : 'white'} bold={active}>
                [{kindTag}]{' '}
              </Text>
              <Text color={active ? 'cyan' : 'green'} bold={active}>
                {item.label}
              </Text>
              <Text dimColor wrap="truncate">
                {' '}
                — {item.desc}
              </Text>
            </Box>
          )
        })
      )}
    </Box>
  )
})

const MessageLine = React.memo(function MessageLine({ m }: { m: PersistedMessage }): React.ReactElement {
  if (m.role === 'user') {
    return (
      <Box
        flexDirection="column"
        marginBottom={1}
        borderStyle="single"
        borderColor="cyan"
        paddingX={1}
      >
        <Text color="cyan" bold>
          You
        </Text>
        <Text wrap="wrap">{m.content}</Text>
      </Box>
    )
  }
  if (m.role === 'assistant') {
    const toolHint = m.toolCalls?.length
      ? `[tools: ${m.toolCalls.map((t) => t.name).join(', ')}]`
      : ''
    return (
      <Box
        flexDirection="column"
        marginBottom={1}
        borderStyle="single"
        borderColor="white"
        paddingX={1}
      >
        <Text bold color="white">
          Assistant
        </Text>
        {(m.content ?? '').trim() ? (
          <Text wrap="wrap">{(m.content ?? '').trim()}</Text>
        ) : null}
        {toolHint ? <Text dimColor>{toolHint}</Text> : null}
      </Box>
    )
  }
  const preview =
    m.content.length > 400 ? `${m.content.slice(0, 400)}…` : m.content
  return (
    <Box
      flexDirection="column"
      marginBottom={1}
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
    >
      <Text dimColor bold>
        tool · {m.name}
      </Text>
      <Text dimColor wrap="wrap">
        {preview}
      </Text>
    </Box>
  )
})
