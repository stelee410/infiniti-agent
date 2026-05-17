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

/**
 * 估算一次 LLM 请求的实际 input tokens：包括 system prompt、tool schema、消息体。
 * compaction 阈值判断应使用此函数，因为 system + tools 也吃上下文。
 */
export function estimateRequestTokens(args: {
  system?: string
  tools?: Array<{ name?: string; description?: string; parameters?: unknown }>
  messages: PersistedMessage[]
}): number {
  let n = estimateMessagesTokens(args.messages)
  if (args.system) n += estimateTextTokens(args.system)
  if (args.tools?.length) {
    for (const t of args.tools) {
      n += estimateTextTokens(t.name ?? '')
      n += estimateTextTokens(t.description ?? '')
      try {
        n += estimateTextTokens(JSON.stringify(t.parameters ?? {}))
      } catch {
        /* ignore non-serializable params */
      }
    }
  }
  return n
}
