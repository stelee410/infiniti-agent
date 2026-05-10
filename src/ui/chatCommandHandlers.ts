import {
  addScheduleTask,
  clearCompletedScheduleTasks,
  formatScheduleTask,
  loadScheduleStore,
  removeScheduleTask,
} from '../schedule/store.js'
import { loadDreamPromptContext, loadLatestDreamDiary } from '../dreaming/dreamStore.js'
import { dreamPromptContextToPromptBlock } from '../dreaming/promptContext.js'
import type { DreamMode } from '../dreaming/types.js'
import type { RunDreamResult } from '../dreaming/dreamRunner.js'
import type { InfinitiConfig } from '../config/types.js'
import { compactSessionMessages } from '../llm/compactSession.js'
import { resolvedCompactionSettings } from '../llm/compactionSettings.js'
import type { PersistedMessage } from '../llm/persisted.js'
import { listInboxMessages, type InboxMessage } from '../inbox/store.js'
import { archiveSession } from '../session/archive.js'
import { rollMessages } from '../session/roll.js'
import { saveSession } from '../session/file.js'
import type { EditHistory } from '../session/editHistory.js'
import { restoreEditSnapshot } from '../tools/repoTools.js'
import { formatChatError } from '../utils/formatError.js'
import { CHAT_HELP_TEXT, type ChatSlashCommand } from './chatSlashCommands.js'
import { splitTtsSegments } from '../tts/streamSegments.js'
import { showMeMagicAppletHtml } from '../liveui/showMeMagicApplet.js'
import { listCachedH5Applets, writeCachedH5Applet } from '../liveui/h5AppletCache.js'

type ScheduleCommand = Extract<
  ChatSlashCommand,
  { kind: 'scheduleList' | 'scheduleClear' | 'scheduleRemove' | 'scheduleAdd' }
>

type InboxCommand = Extract<ChatSlashCommand, { kind: 'inbox' | 'lastEmail' }>
type DreamCommand = Extract<ChatSlashCommand, { kind: 'dreamRun' | 'dreamDiary' | 'dreamContext' }>
type RollCommand = Extract<ChatSlashCommand, { kind: 'roll' }>
type SendMediaCommand = Extract<ChatSlashCommand, { kind: 'sendMedia' }>
type PermissionCommand = Extract<ChatSlashCommand, { kind: 'permission' }>
type CompactCommand = Extract<ChatSlashCommand, { kind: 'compact' }>
type DebugOverlayController = {
  setDebugOverlayEnabled(enabled: boolean): void | Promise<void>
}
type CompactController = {
  compactSessionAsync(options: {
    messages: PersistedMessage[]
    minTailMessages: number
    maxToolSnippetChars: number
    customInstructions?: string
    preCompactHook?: string
  }): Promise<PersistedMessage[]>
}
type DreamController = {
  runDreamNow(options: {
    mode?: DreamMode
    source?: 'manual'
    reason?: string
    writeInbox?: boolean
  }): Promise<RunDreamResult>
}

export type ChatCommandLiveUi = LiveInboxUi & {
  openConfigPanel(cwd: string, config: unknown): void
  createH5Applet(input: {
    title: string
    description?: string
    launchMode?: 'live_panel' | 'floating' | 'fullscreen' | 'overlay'
    permissions?: { network?: boolean; storage?: false | 'session' }
    html: string
  }): { appId: string; status: string }
  launchH5Applet(key: string): void
  sendH5AppletLibrary?(items: Array<{
    id: string
    key: string
    title: string
    description: string
    launchMode: 'live_panel' | 'floating' | 'fullscreen' | 'overlay'
    updatedAt: string
  }>): void
}

export type SpeakCommandLiveUi = {
  hasTts: boolean
  resetAudio(): void
  enqueueTts(text: string): void
}

export type LocalCommandUi = {
  setError(message: string | null): void
  setInput(value: string): void
  setNotice(message: string | null): void
  clearNoticeLater(ms: number): void
  deliverLocalCommandExchange(raw: string, content: string): void
}

export type LiveInboxUi = {
  openInbox(items: Array<{
    id: string
    createdAt: string
    subject: string
    body: string
    attachments: InboxMessage['attachments']
  }>): void
}

export type RollCommandUi = Pick<LocalCommandUi, 'setError' | 'setInput' | 'setNotice' | 'clearNoticeLater'> & {
  setMessages(messages: PersistedMessage[]): void
}

export type CompactCommandUi = Pick<LocalCommandUi, 'setError' | 'setInput' | 'setNotice' | 'clearNoticeLater'> & {
  setMessages(messages: PersistedMessage[]): void
  setCompacting(compacting: boolean): void
}

export type UndoCommandUi = Pick<LocalCommandUi, 'setError' | 'setInput' | 'setNotice' | 'clearNoticeLater'>

export type ClearCommandUi = Pick<LocalCommandUi, 'setInput'> & {
  setMessages(messages: PersistedMessage[]): void
}

export async function handleExitSlashCommand(
  cwd: string,
  messages: PersistedMessage[],
  exitApp: () => void,
): Promise<void> {
  await saveSession(cwd, messages)
  exitApp()
}

export async function handleClearSlashCommand(
  cwd: string,
  messages: PersistedMessage[],
  ui: ClearCommandUi,
): Promise<void> {
  if (messages.length > 0) {
    await archiveSession(cwd, messages).catch(() => {})
  }
  ui.setMessages([])
  await saveSession(cwd, [])
  ui.setInput('')
}

export async function handleReloadSlashCommand(
  reloadAll: () => Promise<void>,
  ui: Pick<LocalCommandUi, 'setInput'>,
): Promise<void> {
  await reloadAll()
  ui.setInput('')
}

export function handleHelpSlashCommand(
  ui: Pick<LocalCommandUi, 'setError' | 'setInput'>,
): void {
  ui.setError(CHAT_HELP_TEXT)
  ui.setInput('')
}

export async function handleShowMeMagicSlashCommand(
  cwd: string,
  liveUi: ChatCommandLiveUi | null | undefined,
  ui: Pick<LocalCommandUi, 'setError' | 'setInput'>,
): Promise<void> {
  if (!liveUi) {
    ui.setError('/showmemagic 需要 LiveUI：请用 `infiniti-agent live` 启动。')
    ui.setInput('')
    return
  }
  const cached = await writeCachedH5Applet(cwd, {
    id: 'official_show_me_magic',
    key: 'official_show_me_magic',
    title: 'Show Me Magic',
    description: '官方 H5/SVG/CSS 动画与交互测试页',
    launchMode: 'live_panel',
    permissions: { network: false, storage: 'session' },
    html: showMeMagicAppletHtml(),
  })
  liveUi.sendH5AppletLibrary?.(await listCachedH5Applets(cwd))
  liveUi.launchH5Applet(cached.key)
  ui.setError(null)
  ui.setInput('')
}

export async function handleScheduleSlashCommand(
  cwd: string,
  raw: string,
  command: ScheduleCommand,
  ui: Pick<LocalCommandUi, 'setError' | 'setInput' | 'deliverLocalCommandExchange'>,
): Promise<void> {
  if (command.kind === 'scheduleList') {
    const store = await loadScheduleStore(cwd)
    const lines = store.tasks.length
      ? `当前计划任务：\n${store.tasks.map((task) => formatScheduleTask(task)).join('\n')}`
      : '暂无计划任务'
    ui.setError(null)
    ui.deliverLocalCommandExchange(raw, lines)
    ui.setInput('')
    return
  }
  if (command.kind === 'scheduleClear') {
    const result = await clearCompletedScheduleTasks(cwd)
    ui.setError(null)
    ui.deliverLocalCommandExchange(
      raw,
      result.removed.length
        ? `已清理 ${result.removed.length} 个未来不再执行的计划任务，剩余 ${result.remaining} 个。`
        : '没有需要清理的计划任务。',
    )
    ui.setInput('')
    return
  }
  if (command.kind === 'scheduleRemove') {
    if (!command.id) {
      ui.setError('请提供计划任务 id 前缀，例如 /schedule remove sch_2026')
      ui.setInput('')
      return
    }
    const removed = await removeScheduleTask(cwd, command.id)
    if (!removed) {
      ui.setError(`没有找到计划任务: ${command.id}`)
    } else {
      ui.setError(null)
      ui.deliverLocalCommandExchange(raw, `已删除计划任务：${removed.prompt}`)
    }
    ui.setInput('')
    return
  }

  if (!command.parsed || !command.parsed.prompt.trim()) {
    ui.setError('计划格式暂支持：每天早上8点做某事、每分钟检查某事、每5分钟做某事、/schedule add 明天9点做某事')
    ui.setInput('')
    return
  }
  const task = await addScheduleTask(cwd, command.parsed)
  ui.setError(null)
  ui.deliverLocalCommandExchange(raw, `已创建计划任务：${formatScheduleTask(task)}`)
  ui.setInput('')
}

export async function handleInboxSlashCommand(
  cwd: string,
  command: InboxCommand,
  liveUi: LiveInboxUi | null | undefined,
  ui: Pick<LocalCommandUi, 'setInput' | 'setNotice' | 'clearNoticeLater'>,
): Promise<void> {
  if (command.kind === 'inbox') {
    const inbox = await listInboxMessages(cwd, { unreadOnly: command.unreadOnly, limit: 8 })
    const scope = command.unreadOnly ? '未读' : '最近'
    ui.setNotice(
      inbox.length
        ? inbox.map((m) => `${m.createdAt} ${m.subject} (${m.id})`).join('\n')
        : `${scope}你的邮箱为空`,
    )
    ui.clearNoticeLater(inbox.length ? 15000 : 5000)
    ui.setInput('')
    return
  }

  const inbox = await listInboxMessages(cwd, { limit: 1 })
  const last = inbox[0]
  if (!last) {
    ui.setNotice('你的邮箱为空')
    ui.clearNoticeLater(5000)
  } else if (liveUi) {
    liveUi.openInbox([inboxMessageToLiveUiItem(last)])
    ui.setNotice(`已打开上一封信：${last.subject}`)
    ui.clearNoticeLater(5000)
  } else {
    const attachments = last.attachments.length
      ? `\n附件：${last.attachments.map((a) => a.path).join('\n')}`
      : ''
    ui.setNotice(`${last.createdAt} ${last.subject}\n\n${last.body}${attachments}`)
    ui.clearNoticeLater(15000)
  }
  ui.setInput('')
}

export async function handleDreamSlashCommand(
  cwd: string,
  raw: string,
  command: DreamCommand,
  dreamController: DreamController | null | undefined,
  ui: Pick<LocalCommandUi, 'setError' | 'setInput' | 'setNotice' | 'clearNoticeLater' | 'deliverLocalCommandExchange'>,
): Promise<void> {
  if (command.kind === 'dreamRun') {
    if (!dreamController) {
      ui.setError('/dream run 需要 subconscious-agent 已启动')
      ui.setInput('')
      return
    }
    ui.setError(null)
    ui.setNotice('我开始做梦了，完成后会写入 dream diary 和 prompt context…')
    const result = await dreamController.runDreamNow({
      mode: command.mode,
      source: 'manual',
      reason: 'manual slash command',
      writeInbox: true,
    })
    if (result.run.status === 'completed') {
      ui.deliverLocalCommandExchange(
        raw,
        [
          `Dream run completed: ${result.run.id}`,
          result.deep?.dreamDiary.summary ? `summary: ${result.deep.dreamDiary.summary}` : '',
          result.deep?.promptContext.longHorizonObjective ? `objective: ${result.deep.promptContext.longHorizonObjective}` : '',
        ].filter(Boolean).join('\n'),
      )
      ui.setNotice('梦境整理完成')
      ui.clearNoticeLater(5000)
    } else if (result.run.status === 'skipped') {
      ui.deliverLocalCommandExchange(raw, '没有足够的新内容，本次梦境已跳过。')
    } else {
      ui.setError(result.run.error ?? 'Dream run failed')
    }
    ui.setInput('')
    return
  }

  if (command.kind === 'dreamDiary') {
    const diary = await loadLatestDreamDiary(cwd)
    ui.setError(null)
    ui.deliverLocalCommandExchange(
      raw,
      diary
        ? [
            `${diary.title} (${diary.createdAt})`,
            '',
            diary.summary,
            '',
            '理解：',
            ...diary.whatIUnderstood.slice(0, 6).map((item) => `- ${item}`),
            diary.currentObjective ? `\n当前长期目标：\n${diary.currentObjective}` : '',
          ].filter(Boolean).join('\n')
        : '还没有梦境笔记。可以用 /dream run 手动触发一次。',
    )
    ui.setInput('')
    return
  }

  const context = await loadDreamPromptContext(cwd)
  ui.setError(null)
  ui.deliverLocalCommandExchange(
    raw,
    dreamPromptContextToPromptBlock(context) || '还没有 Dream Context。可以用 /dream run 手动触发一次。',
  )
  ui.setInput('')
}

export async function handleRollSlashCommand(
  cwd: string,
  messages: PersistedMessage[],
  command: RollCommand,
  ui: RollCommandUi,
): Promise<void> {
  if (command.layers == null) {
    ui.setError('/roll 后请输入正整数，例如 /roll 2')
    ui.setInput('')
    return
  }
  const res = rollMessages(messages, command.layers)
  if (res.layers === 0) {
    ui.setError('没有可回滚的 LLM 输出层')
    ui.setInput('')
    return
  }
  ui.setMessages(res.messages)
  await saveSession(cwd, res.messages)
  ui.setError(null)
  ui.setNotice(`已回滚 ${res.layers} 层，删除 ${res.removed} 条消息`)
  ui.clearNoticeLater(5000)
  ui.setInput('')
}

export function handleCompactSlashCommand(
  cwd: string,
  config: InfinitiConfig,
  messages: PersistedMessage[],
  command: CompactCommand,
  compactController: CompactController | null | undefined,
  ui: CompactCommandUi,
): void {
  if (messages.length < 2) {
    ui.setError('消息过少，无需压缩')
    ui.setInput('')
    return
  }
  ui.setCompacting(true)
  ui.setError(null)
  ui.setNotice('已提交后台压缩；期间记忆写入会排队等待…')
  const cs = resolvedCompactionSettings(config)
  const runCompact = compactController
    ? compactController.compactSessionAsync({
        messages,
        minTailMessages: cs.minTailMessages,
        maxToolSnippetChars: cs.maxToolSnippetChars,
        customInstructions: command.instructions || undefined,
        preCompactHook: cs.preCompactHook,
      })
    : compactSessionMessages({
        config,
        cwd,
        messages,
        minTailMessages: cs.minTailMessages,
        maxToolSnippetChars: cs.maxToolSnippetChars,
        customInstructions: command.instructions || undefined,
        preCompactHook: cs.preCompactHook,
      }).then(async (next) => {
        await saveSession(cwd, next)
        return next
      })
  void runCompact
    .then((next) => {
      ui.setMessages(next)
      ui.setNotice(`后台压缩完成：保留最近约 ${cs.minTailMessages} 条消息起的上下文`)
      ui.clearNoticeLater(5000)
    })
    .catch((e: unknown) => {
      ui.setError(formatChatError(e))
      ui.setNotice(null)
    })
    .finally(() => ui.setCompacting(false))
  ui.setInput('')
}

export async function handleUndoSlashCommand(
  cwd: string,
  editHistory: Pick<EditHistory, 'peek' | 'pop'>,
  ui: UndoCommandUi,
): Promise<void> {
  const snap = editHistory.peek()
  if (!snap) {
    ui.setError('没有可撤销的编辑（仅记录本会话内成功的 write_file / str_replace）')
    ui.setInput('')
    return
  }
  try {
    const out = await restoreEditSnapshot(cwd, snap)
    const j = JSON.parse(out) as { ok?: boolean; error?: string }
    if (!j.ok) {
      ui.setError(j.error ?? '撤销失败')
    } else {
      editHistory.pop()
      ui.setError(null)
      ui.setNotice(`已撤销: ${snap.relPath}`)
      ui.clearNoticeLater(4000)
    }
  } catch (e: unknown) {
    ui.setError(formatChatError(e))
  }
  ui.setInput('')
}

export function handleMemorySlashCommand(
  ui: Pick<LocalCommandUi, 'setError' | 'setInput'>,
): void {
  ui.setError('记忆系统：memory.json（结构化记忆）+ user_profile.json（用户画像）— 在 .infiniti-agent/ 下')
  ui.setInput('')
}

export type SendMediaLiveUi = {
  sendAssistantMedia(args: {
    filePath: string
    kind: 'image' | 'video' | 'file'
    caption?: string
    timeoutMs?: number
  }): Promise<{ ok: boolean; error?: string; requestId: string }>
}

export async function handleSendMediaSlashCommand(
  cwd: string,
  command: SendMediaCommand,
  liveUi: SendMediaLiveUi | null | undefined,
  ui: Pick<LocalCommandUi, 'setError' | 'setInput' | 'setNotice' | 'clearNoticeLater'>,
): Promise<void> {
  ui.setInput('')
  if (!command.path.trim()) {
    ui.setError(`/${command.mediaKind === 'image' ? 'sendImage' : command.mediaKind === 'video' ? 'sendVideo' : 'sendFile'} 需要文件路径，例如 /sendImage ./out.png`)
    return
  }
  if (!liveUi) {
    ui.setError('未连接 LiveUI 客户端（如 infiniti-weixin-bridge），无法投递媒体。')
    return
  }
  const { isAbsolute, resolve } = await import('node:path')
  const { stat } = await import('node:fs/promises')
  const resolved = isAbsolute(command.path) ? command.path : resolve(cwd, command.path)
  try {
    const info = await stat(resolved)
    if (!info.isFile()) {
      ui.setError(`不是文件: ${resolved}`)
      return
    }
  } catch (e) {
    ui.setError(`无法访问文件 ${resolved}: ${(e as Error).message}`)
    return
  }
  ui.setNotice(`正在投递 ${command.mediaKind}: ${resolved}…`)
  const result = await liveUi.sendAssistantMedia({
    filePath: resolved,
    kind: command.mediaKind,
    ...(command.caption ? { caption: command.caption } : {}),
  })
  if (result.ok) {
    ui.setError(null)
    ui.setNotice(`✓ ${command.mediaKind} 已交给客户端 (${result.requestId})`)
    ui.clearNoticeLater(4000)
  } else {
    ui.setError(`投递失败: ${result.error ?? '未知错误'}`)
  }
}

export function handlePermissionSlashCommand(
  command: PermissionCommand,
  dangerouslySkipPermissions: boolean | undefined,
  ui: Pick<LocalCommandUi, 'setInput' | 'setNotice' | 'clearNoticeLater'>,
): void {
  void command
  const mode = dangerouslySkipPermissions
    ? '全部跳过（--dangerously-skip-permissions）'
    : 'meta-agent 自动评估（规则引擎 + LLM 兜底，blocked 走对话确认）'
  ui.setNotice(`权限模式: ${mode}`)
  ui.clearNoticeLater(8000)
  ui.setInput('')
}

export function handleConfigSlashCommand(
  cwd: string,
  config: unknown,
  liveUi: Pick<ChatCommandLiveUi, 'openConfigPanel'> | null | undefined,
  ui: Pick<LocalCommandUi, 'setError' | 'setInput' | 'setNotice' | 'clearNoticeLater'>,
): void {
  if (!liveUi) {
    ui.setError('/config 暂不支持当前模式；请使用 infiniti-agent live 后在 Live 窗口输入 /config')
    ui.setInput('')
    return
  }
  liveUi.openConfigPanel(cwd, config)
  ui.setNotice('已打开 Live 配置面板')
  ui.clearNoticeLater(3000)
  ui.setInput('')
}

export function handleDebugSlashCommand(
  liveUi: unknown,
  debugOverlayEnabled: boolean,
  setDebugOverlayEnabled: (enabled: boolean) => void,
  debugController: DebugOverlayController | null | undefined,
  ui: Pick<LocalCommandUi, 'setError' | 'setInput' | 'setNotice' | 'clearNoticeLater'>,
): void {
  if (!liveUi) {
    ui.setError('/debug 仅在 live 模式可用')
    ui.setInput('')
    return
  }
  const next = !debugOverlayEnabled
  setDebugOverlayEnabled(next)
  void debugController?.setDebugOverlayEnabled(next)
  ui.setError(null)
  ui.setNotice(next ? 'LiveUI debug 已开启' : 'LiveUI debug 已关闭')
  ui.clearNoticeLater(4000)
  ui.setInput('')
}

export function handleSpeakSlashCommand(
  speakText: string,
  liveUi: SpeakCommandLiveUi | null | undefined,
  ui: Pick<LocalCommandUi, 'setError' | 'setInput'>,
): void {
  if (!liveUi) {
    ui.setError('当前不是 Live 模式，无法使用 /speak（请用 infiniti-agent live）')
    ui.setInput('')
    return
  }
  if (!liveUi.hasTts) {
    ui.setError('未配置 TTS，无法 /speak')
    ui.setInput('')
    return
  }
  const text = speakText.trim()
  if (!text) {
    ui.setError('/speak 后请输入要朗读的文本，例如：/speak 你好，这是音色测试')
    ui.setInput('')
    return
  }
  liveUi.resetAudio()
  for (const seg of splitTtsSegments(text)) {
    liveUi.enqueueTts(seg)
  }
  ui.setInput('')
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
