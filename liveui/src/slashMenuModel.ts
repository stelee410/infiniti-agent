export type SlashRow = { id: string; kind: string; label: string; desc: string; insert: string }

export type SlashMenuWindow<T> = {
  selected: number
  start: number
  visible: T[]
}

export function clampSlashSelection(length: number, selected: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(selected, length - 1))
}

export function slashMenuWindow<T>(rows: T[], selected: number, maxRows: number): SlashMenuWindow<T> {
  const safeMax = Math.max(1, maxRows)
  const safeSelected = clampSlashSelection(rows.length, selected)
  let start = 0
  if (rows.length > safeMax) {
    start = Math.max(0, Math.min(safeSelected - Math.floor(safeMax / 2), rows.length - safeMax))
  }
  return {
    selected: safeSelected,
    start,
    visible: rows.slice(start, start + safeMax),
  }
}

export function slashMenuHintText(total: number): string {
  return total === 0
    ? '无匹配项，继续输入或退格'
    : `↑↓ 选择 · Tab 写入 — 共 ${total} 项`
}

export function slashInsertText(insert: string): string {
  return insert.endsWith(' ') ? insert : `${insert} `
}
