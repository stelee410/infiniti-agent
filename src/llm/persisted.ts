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

export type UserFileAttachment = {
  id: string
  name: string
  mediaType: string
  base64: string
  size: number
  kind: 'image' | 'document'
  capturedAt: string
  text?: string
}

export type PersistedMessageMeta = {
  /** ISO timestamp for persistence/analytics only. It is not sent to LLM context. */
  createdAt?: string
}

export type PersistedMessage =
  | ({ role: 'user'; content: string; vision?: UserVisionAttachment; attachments?: UserFileAttachment[] } & PersistedMessageMeta)
  | {
      role: 'assistant'
      content: string | null
      toolCalls?: ToolCallSpec[]
    } & PersistedMessageMeta
  | {
      role: 'tool'
      toolCallId: string
      name: string
      content: string
    } & PersistedMessageMeta

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
    if (m.role === 'user' && (m.vision || m.attachments?.length)) {
      const { vision: _vision, attachments: _attachments, ...rest } = m
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

export function withMessageTimestamps(messages: PersistedMessage[], now = new Date().toISOString()): PersistedMessage[] {
  return messages.map((m) => m.createdAt ? m : { ...m, createdAt: now })
}

/**
 * 删除「空 assistant」消息：既没有 content（或空串/null）也没有 toolCalls。
 * 这种消息常见于上游被审核挡掉或流被中断，但保留它会让非 OpenAI 的 chat 上游
 * （如 mimo / litellm）下一轮直接 502 "Param Incorrect"。
 */
export function dropEmptyAssistantTurns(messages: PersistedMessage[]): PersistedMessage[] {
  return messages.filter((m) => {
    if (m.role !== 'assistant') return true
    const hasContent = typeof m.content === 'string' && m.content.trim().length > 0
    const hasToolCalls = (m.toolCalls?.length ?? 0) > 0
    return hasContent || hasToolCalls
  })
}
