import { parseScheduleRequest } from '../schedule/parser.js'
import type { ScheduleCreateInput } from '../schedule/store.js'

export const CHAT_HELP_TEXT =
  '输入 / 可补全：斜杠命令与全部工具（↑↓ Tab）。命令: /exit /clear /reload /config /schedule /memory /inbox /last_email /undo /roll /compact /permission /speak /snap /avatargen /video — /schedule list 查看计划，/schedule add 每天早上8点做某事 创建计划；自然语言提醒/定时会由模型调用 schedule 工具。/config 仅 Live 模式打开配置面板；/last_email 打开最近一封邮箱消息；/speak 后接正文仅 TTS 朗读、不写会话；/snap 后接提示词异步生成合照/写实照片；/avatargen 后接要求并附带头像图，异步生成 real2d 的 exp01..exp06 与 exp_open；/video 后接提示词异步生成 Seedance 视频，完成后写入你的邮箱。/roll 2 可按 LLM 输出层回滚对话。改文件/bash/HTTP 默认需确认（Y 允许 · A 本次会话始终允许该工具 · N 拒绝）；启动时加 --dangerously-skip-permissions 可跳过所有确认。/permission 查看当前状态。/compact 压缩较早历史。卡死排查：INFINITI_AGENT_DEBUG=1。'

export type ChatSlashCommand =
  | { kind: 'exit' }
  | { kind: 'clear' }
  | { kind: 'reload' }
  | { kind: 'config' }
  | { kind: 'debug' }
  | { kind: 'scheduleList' }
  | { kind: 'scheduleClear' }
  | { kind: 'scheduleRemove'; id: string }
  | { kind: 'scheduleAdd'; parsed: ScheduleCreateInput | null }
  | { kind: 'dreamRun'; mode: 'light' | 'full' }
  | { kind: 'dreamDiary' }
  | { kind: 'dreamContext' }
  | { kind: 'memory' }
  | { kind: 'inbox'; unreadOnly: boolean }
  | { kind: 'lastEmail' }
  | { kind: 'help' }
  | { kind: 'compact'; instructions: string }
  | { kind: 'permission' }
  | { kind: 'undo' }
  | { kind: 'roll'; layers: number | null }

type ExactCommand = {
  names: readonly string[]
  kind: Exclude<ChatSlashCommand['kind'],
    | 'scheduleRemove'
    | 'scheduleAdd'
    | 'dreamRun'
    | 'inbox'
    | 'compact'
    | 'roll'
  >
}

const EXACT_COMMANDS: readonly ExactCommand[] = [
  { names: ['/exit', '/quit'], kind: 'exit' },
  { names: ['/clear', '/new'], kind: 'clear' },
  { names: ['/reload', '/reload-skills'], kind: 'reload' },
  { names: ['/config'], kind: 'config' },
  { names: ['/debug'], kind: 'debug' },
  { names: ['/schedule', '/schedule list'], kind: 'scheduleList' },
  { names: ['/schedule clear'], kind: 'scheduleClear' },
  { names: ['/dream', '/dream diary'], kind: 'dreamDiary' },
  { names: ['/dream context'], kind: 'dreamContext' },
  { names: ['/memory'], kind: 'memory' },
  { names: ['/last_email'], kind: 'lastEmail' },
  { names: ['/help'], kind: 'help' },
  { names: ['/permission'], kind: 'permission' },
  { names: ['/undo'], kind: 'undo' },
] as const

export function parseChatSlashCommand(raw: string): ChatSlashCommand | null {
  for (const spec of EXACT_COMMANDS) {
    if (spec.names.includes(raw)) {
      return { kind: spec.kind } as ChatSlashCommand
    }
  }

  if (raw.startsWith('/schedule remove ') || raw.startsWith('/schedule rm ')) {
    return {
      kind: 'scheduleRemove',
      id: raw.replace(/^\/schedule\s+(remove|rm)\s+/i, '').trim(),
    }
  }
  if (raw.startsWith('/schedule add ')) {
    return {
      kind: 'scheduleAdd',
      parsed: parseScheduleRequest(raw),
    }
  }
  if (raw === '/dream run' || raw.startsWith('/dream run ')) {
    const arg = raw.startsWith('/dream run ') ? raw.slice('/dream run '.length).trim() : ''
    return {
      kind: 'dreamRun',
      mode: arg === 'light' ? 'light' : 'full',
    }
  }
  if (raw === '/inbox' || raw.startsWith('/inbox ')) {
    return {
      kind: 'inbox',
      unreadOnly: !raw.includes('--all'),
    }
  }
  if (raw === '/compact' || raw.startsWith('/compact ')) {
    return {
      kind: 'compact',
      instructions: raw.startsWith('/compact ') ? raw.slice('/compact '.length).trim() : '',
    }
  }
  if (raw === '/roll' || raw.startsWith('/roll ')) {
    const arg = raw.startsWith('/roll ') ? raw.slice('/roll '.length).trim() : ''
    const layers = arg ? Number(arg) : 1
    return {
      kind: 'roll',
      layers: Number.isInteger(layers) && layers >= 1 ? layers : null,
    }
  }

  return null
}
