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
  shouldStreamTtsPlayback?: boolean
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

export type QueuedMediaJob = { id: string }

export type RunQueuedMediaCommandArgs<TVision, TAttachment, TAvatarRef, TVideoRef> = {
  command: ParsedQueuedMediaCommand
  getVision(): TVision | undefined
  getFileAttachments(): TAttachment[]
  clearVisionAttachment(): void
  clearFileAttachments(): void
  avatarReferences(vision: TVision | undefined, attachments: TAttachment[]): TAvatarRef[]
  videoReferences(vision: TVision | undefined, attachments: TAttachment[]): TVideoRef[]
  enqueueAvatar(prompt: string, references: TAvatarRef[]): Promise<QueuedMediaJob>
  enqueueVideo(prompt: string, references: TVideoRef[]): Promise<QueuedMediaJob>
  enqueueSnap(prompt: string, vision: TVision | undefined): Promise<QueuedMediaJob>
  polishAvatar(prompt: string, jobId: string): Promise<string>
  polishVideo(prompt: string, jobId: string): Promise<string>
  polishSnap(prompt: string, jobId: string): Promise<string>
}

export async function runQueuedMediaCommand<TVision, TAttachment, TAvatarRef, TVideoRef>(
  args: RunQueuedMediaCommandArgs<TVision, TAttachment, TAvatarRef, TVideoRef>,
): Promise<string> {
  const prompt = args.command.prompt
  if (args.command.kind === 'avatargen') {
    const vision = args.getVision()
    const attachments = args.getFileAttachments()
    const job = await args.enqueueAvatar(prompt, args.avatarReferences(vision, attachments))
    clearConsumedMediaInputs(args, vision, attachments)
    return args.polishAvatar(prompt, job.id)
  }
  if (args.command.kind === 'video') {
    const vision = args.getVision()
    const attachments = args.getFileAttachments()
    const job = await args.enqueueVideo(prompt, args.videoReferences(vision, attachments))
    clearConsumedMediaInputs(args, vision, attachments)
    return args.polishVideo(prompt, job.id)
  }

  const vision = args.getVision()
  const job = await args.enqueueSnap(prompt, vision)
  if (vision) args.clearVisionAttachment()
  return args.polishSnap(prompt, job.id)
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
    if (args.liveUi.shouldStreamTtsPlayback ?? args.liveUi.hasTts) {
      args.liveUi.resetAudio()
      for (const seg of splitTtsSegments(args.cleanForTts(args.assistantContent))) {
        args.liveUi.enqueueTts(seg)
      }
    }
  }
  return next
}

function clearConsumedMediaInputs<TVision, TAttachment>(
  args: Pick<RunQueuedMediaCommandArgs<TVision, TAttachment, unknown, unknown>, 'clearVisionAttachment' | 'clearFileAttachments'>,
  vision: TVision | undefined,
  attachments: TAttachment[],
): void {
  if (vision) args.clearVisionAttachment()
  else if (attachments.length) args.clearFileAttachments()
}
