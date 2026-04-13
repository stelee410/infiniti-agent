import type { PersistedMessage } from './persisted.js'

// eslint-disable-next-line no-control-regex
const RE_CJK = /[\u2E80-\u9FFF\uF900-\uFAFF]/g

/**
 * 粗估 token 数。英文约 4 字符/token，CJK 字符约 1.5 字符/token。
 * 按 CJK 占比混合加权，使中文场景下的阈值触发更准确。
 */
export function estimateTextTokens(text: string): number {
  if (!text) {
    return 0
  }
  const cjkCount = (text.match(RE_CJK) ?? []).length
  const nonCjkCount = text.length - cjkCount
  return Math.ceil(nonCjkCount / 4 + cjkCount / 1.5)
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
