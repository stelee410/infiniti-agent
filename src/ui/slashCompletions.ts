import { BUILTIN_TOOLS } from '../tools/definitions.js'
import type { McpManager } from '../mcp/manager.js'

export type SlashItemKind = 'command' | 'tool'

export type SlashItem = {
  /** 用于筛选与展示 */
  id: string
  kind: SlashItemKind
  label: string
  desc: string
  /** Tab 补全后整行输入（会替换当前 `/…`） */
  insert: string
}

const COMMAND_ITEMS: SlashItem[] = [
  {
    id: '/exit',
    kind: 'command',
    label: '/exit',
    desc: '退出并保存会话',
    insert: '/exit ',
  },
  {
    id: '/quit',
    kind: 'command',
    label: '/quit',
    desc: '同 /exit',
    insert: '/quit ',
  },
  {
    id: '/new',
    kind: 'command',
    label: '/new',
    desc: '归档当前会话并开始新对话',
    insert: '/new ',
  },
  {
    id: '/clear',
    kind: 'command',
    label: '/clear',
    desc: '归档并清空当前对话（同 /new）',
    insert: '/clear ',
  },
  {
    id: '/reload',
    kind: 'command',
    label: '/reload',
    desc: '重载 config.json 并重启 MCP',
    insert: '/reload ',
  },
  {
    id: '/config',
    kind: 'command',
    label: '/config',
    desc: '打开 Live 模式 Electron 配置面板',
    insert: '/config ',
  },
  {
    id: '/reload-skills',
    kind: 'command',
    label: '/reload-skills',
    desc: '同 /reload',
    insert: '/reload-skills ',
  },
  {
    id: '/memory',
    kind: 'command',
    label: '/memory',
    desc: '提示长期记忆文件路径',
    insert: '/memory ',
  },
  {
    id: '/inbox',
    kind: 'command',
    label: '/inbox',
    desc: '查看你的邮箱里最近未读邮件；加 --all 查看最近全部',
    insert: '/inbox ',
  },
  {
    id: '/help',
    kind: 'command',
    label: '/help',
    desc: '显示斜杠命令说明',
    insert: '/help ',
  },
  {
    id: '/speak',
    kind: 'command',
    label: '/speak',
    desc: '仅 TTS 朗读其后文本（不写会话，Live 测音色）',
    insert: '/speak ',
  },
  {
    id: '/snap',
    kind: 'command',
    label: '/snap',
    desc: '用已确认照片和 agent 参考图生成合照；无照片时按提示词生成写实照片',
    insert: '/snap ',
  },
  {
    id: '/undo',
    kind: 'command',
    label: '/undo',
    desc: '撤销最近一次 write_file/str_replace（内存栈）',
    insert: '/undo ',
  },
  {
    id: '/permission',
    kind: 'command',
    label: '/permission',
    desc: '查看当前权限模式与白名单（启动加 --dangerously-skip-permissions 可跳过全部确认）',
    insert: '/permission ',
  },
  {
    id: '/compact',
    kind: 'command',
    label: '/compact',
    desc: '压缩较早会话为摘要（保留尾部消息与工具链）',
    insert: '/compact ',
  },
]

/** 合并斜杠命令、内置工具、MCP 工具（供 / 补全） */
export function buildSlashItems(mcp: McpManager): SlashItem[] {
  const builtinToolItems: SlashItem[] = BUILTIN_TOOLS.map((t) => ({
    id: t.name,
    kind: 'tool',
    label: t.name,
    desc: t.description,
    insert: `${t.name} — `,
  }))

  const mcpItems: SlashItem[] = mcp.getToolSpecs().map((t) => ({
    id: t.name,
    kind: 'tool',
    label: t.name,
    desc:
      t.description.length > 100
        ? `${t.description.slice(0, 100)}…`
        : t.description,
    insert: `${t.name} — `,
  }))

  return [...COMMAND_ITEMS, ...builtinToolItems, ...mcpItems]
}

/**
 * 当前输入为单行且以 / 开头、中间无空格时进入补全模式。
 * query 为 `/` 后的片段（可空，表示列出全部）。
 */
export function filterSlashItems(
  items: SlashItem[],
  input: string,
): SlashItem[] {
  if (!input.startsWith('/') || input.includes(' ') || input.includes('\n')) {
    return []
  }
  const q = input.slice(1).toLowerCase()
  if (!q) {
    return items
  }
  return items.filter((i) => {
    const id = i.id.toLowerCase()
    const label = i.label.toLowerCase()
    const desc = i.desc.toLowerCase()
    return (
      id.includes(q) ||
      label.includes(q) ||
      desc.includes(q) ||
      (id.startsWith('/') && id.slice(1).includes(q))
    )
  })
}
