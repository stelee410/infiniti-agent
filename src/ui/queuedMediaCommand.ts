import type { PersistedMessage } from '../llm/persisted.js'
import { splitTtsSegments } from '../tts/streamSegments.js'

export type QueuedMediaCommandKind = 'avatargen' | 'video' | 'snap'

export type ParsedQueuedMediaCommand = {
  kind: QueuedMediaCommandKind
  prefix: '/avatargen' | '/video' | '/seedance' | '/snap'
  prompt: string
}

const MEDIA_COMMAND_PREFIXES = [
  { prefix: '/avatargen', kind: 'avatargen' },
  { prefix: '/seedance', kind: 'video' },
  { prefix: '/video', kind: 'video' },
  { prefix: '/snap', kind: 'snap' },
] as const

export function parseQueuedMediaCommand(raw: string): ParsedQueuedMediaCommand | null {
  for (const item of MEDIA_COMMAND_PREFIXES) {
    if (raw === item.prefix || raw.startsWith(`${item.prefix} `)) {
      return {
        kind: item.kind,
        prefix: item.prefix,
        prompt: raw.startsWith(`${item.prefix} `)
          ? raw.slice(item.prefix.length + 1).trim()
          : '',
      }
    }
  }
  return null
}

export function queuedMediaEmptyPromptMessage(command: ParsedQueuedMediaCommand): string {
  if (command.kind === 'avatargen') {
    return '/avatargen 后请输入要求，例如：/avatargen 城市猎人风格的美少女'
  }
  if (command.kind === 'video') {
    return `${command.prefix} 后请输入提示词，例如：${command.prefix} 夕阳海边的电影感航拍，慢速推进`
  }
  return '/snap 后请输入提示词，例如：/snap 在咖啡馆自拍，暖色灯光'
}

export function queuedMediaNotice(kind: QueuedMediaCommandKind): string {
  if (kind === 'avatargen') {
    return 'Real2D 表情集任务已交给 AvatarGen 后台处理，完成后会放进你的邮箱'
  }
  if (kind === 'video') {
    return '视频任务已交给 Seedance 后台处理，完成后会放进你的邮箱'
  }
  return '图片任务已交给后台处理，一会儿会放进你的邮箱'
}

export type QueuedMediaLiveUi = {
  hasTts: boolean
  sendAssistantStream(content: string, done: boolean, replace: boolean): void
  resetAudio(): void
  enqueueTts(text: string): void
}

export type FinalizeQueuedMediaCommandArgs = {
  cwd: string
  messages: PersistedMessage[]
  rawCommand: string
  assistantContent: string
  liveUi?: QueuedMediaLiveUi | null
  cleanForTts: (content: string) => string
  observeAssistantOutput?: (content: string) => void | Promise<void>
  saveSession: (cwd: string, messages: PersistedMessage[]) => Promise<void>
  setMessages: (messages: PersistedMessage[]) => void
  setNotice: (notice: string | null) => void
  clearNoticeLater?: (ms: number) => void
}

export async function finalizeQueuedMediaCommand(
  args: FinalizeQueuedMediaCommandArgs,
): Promise<PersistedMessage[]> {
  void args.observeAssistantOutput?.(args.assistantContent)
  const next: PersistedMessage[] = [
    ...args.messages,
    { role: 'user', content: args.rawCommand },
    { role: 'assistant', content: args.assistantContent },
  ]
  args.setMessages(next)
  await args.saveSession(args.cwd, next)
  args.setNotice(args.assistantContent)
  args.clearNoticeLater?.(12000)

  if (args.liveUi) {
    args.liveUi.sendAssistantStream(args.assistantContent, true, true)
    if (args.liveUi.hasTts) {
      args.liveUi.resetAudio()
      for (const seg of splitTtsSegments(args.cleanForTts(args.assistantContent))) {
        args.liveUi.enqueueTts(seg)
      }
    }
  }
  return next
}
