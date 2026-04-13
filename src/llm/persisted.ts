export type ToolCallSpec = {
  id: string
  name: string
  argumentsJson: string
}

export type PersistedMessage =
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      content: string | null
      toolCalls?: ToolCallSpec[]
    }
  | {
      role: 'tool'
      toolCallId: string
      name: string
      content: string
    }

export type SessionFileV1 = {
  version: 1
  cwd: string
  messages: PersistedMessage[]
}

const MAX_TOOL_RESULT_CHARS = 8000

/**
 * 截断过大的 tool 结果消息，减少 session 膨胀。
 * 返回新数组（不修改原数组）。
 */
export function truncateToolResults(
  messages: PersistedMessage[],
  maxChars: number = MAX_TOOL_RESULT_CHARS,
): PersistedMessage[] {
  return messages.map((m) => {
    if (m.role !== 'tool' || m.content.length <= maxChars) return m
    return {
      ...m,
      content:
        m.content.slice(0, maxChars) +
        `\n…（已截断，原始 ${m.content.length} 字符）`,
    }
  })
}
