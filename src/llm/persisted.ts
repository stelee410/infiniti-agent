export type ToolCallSpec = {
  id: string
  name: string
  argumentsJson: string
}

export type UserVisionAttachment = {
  imageBase64: string
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
  capturedAt: string
  location?: {
    latitude: number
    longitude: number
    accuracy?: number
  }
}

export type PersistedMessage =
  | { role: 'user'; content: string; vision?: UserVisionAttachment }
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
    if (m.role === 'user' && m.vision) {
      const { vision: _vision, ...rest } = m
      return rest
    }
    if (m.role !== 'tool' || m.content.length <= maxChars) return m
    return {
      ...m,
      content:
        m.content.slice(0, maxChars) +
        `\n…（已截断，原始 ${m.content.length} 字符）`,
    }
  })
}
