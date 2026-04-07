import type { PersistedMessage } from './persisted.js'

/** 粗估 token（约 4 UTF-16 单元 ≈ 1 token），用于压缩阈值，不追求与计费一致 */
export function estimateTextTokens(text: string): number {
  if (!text) {
    return 0
  }
  return Math.ceil(text.length / 4)
}

export function estimateMessagesTokens(messages: PersistedMessage[]): number {
  let n = 0
  for (const m of messages) {
    if (m.role === 'user') {
      n += estimateTextTokens(m.content)
    } else if (m.role === 'assistant') {
      n += estimateTextTokens(m.content ?? '')
      if (m.toolCalls?.length) {
        for (const tc of m.toolCalls) {
          n += estimateTextTokens(tc.name) + estimateTextTokens(tc.argumentsJson)
        }
      }
    } else {
      n += estimateTextTokens(m.name) + estimateTextTokens(m.content)
    }
  }
  return n
}
