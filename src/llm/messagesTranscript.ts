import type { PersistedMessage } from './persisted.js'

function snip(s: string, max: number): string {
  if (s.length <= max) {
    return s
  }
  return `${s.slice(0, max)}\n…(已截断，共 ${s.length} 字符)`
}

/** 将待压缩前缀转为纯文本，供摘要模型阅读 */
export function messagesToCompactTranscript(
  messages: PersistedMessage[],
  maxToolSnippetChars: number,
): string {
  const lines: string[] = []
  let i = 0
  while (i < messages.length) {
    const m = messages[i]!
    if (m.role === 'user') {
      lines.push(`### 用户\n${m.content}`)
      i++
      continue
    }
    if (m.role === 'assistant') {
      const parts: string[] = []
      if (m.content?.trim()) {
        parts.push(m.content.trim())
      }
      if (m.toolCalls?.length) {
        for (const tc of m.toolCalls) {
          parts.push(
            `[工具调用] ${tc.name} ${snip(tc.argumentsJson, 2000)}`,
          )
        }
      }
      lines.push(`### 助手\n${parts.join('\n') || '（无正文）'}`)
      i++
      continue
    }
    if (m.role === 'tool') {
      const block: string[] = []
      while (i < messages.length && messages[i]!.role === 'tool') {
        const t = messages[i] as Extract<PersistedMessage, { role: 'tool' }>
        block.push(`- ${t.name}: ${snip(t.content, maxToolSnippetChars)}`)
        i++
      }
      lines.push(`### 工具结果\n${block.join('\n')}`)
      continue
    }
    i++
  }
  return lines.join('\n\n')
}
