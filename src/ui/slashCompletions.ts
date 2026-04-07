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
    id: '/clear',
    kind: 'command',
    label: '/clear',
    desc: '清空当前对话与 session.json',
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
    id: '/help',
    kind: 'command',
    label: '/help',
    desc: '显示斜杠命令说明',
    insert: '/help ',
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
  if (!input.startsWith('/') || input.includes(' ')) {
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
