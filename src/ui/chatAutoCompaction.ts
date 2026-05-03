import type { InfinitiConfig } from '../config/types.js'
import { compactSessionMessages } from '../llm/compactSession.js'
import { resolvedCompactionSettings } from '../llm/compactionSettings.js'
import { estimateMessagesTokens } from '../llm/estimateTokens.js'
import type { PersistedMessage } from '../llm/persisted.js'
import { archiveSession } from '../session/archive.js'
import { saveSession } from '../session/file.js'
import { agentDebug } from '../utils/agentDebug.js'
import { formatChatError } from '../utils/formatError.js'

export type AutoCompactionController = {
  compactSessionAsync(options: {
    messages: PersistedMessage[]
    minTailMessages: number
    maxToolSnippetChars: number
    preCompactHook?: string
  }): Promise<PersistedMessage[]>
}

export type AutoCompactionUi = {
  setCompacting(compacting: boolean): void
  setNotice(message: string | null): void
  setError(message: string | null): void
  setBusy(busy: boolean): void
  setMessages(messages: PersistedMessage[]): void
  getMessages?: () => PersistedMessage[]
  clearNoticeLater(ms: number): void
}

export function maybeStartAutoCompaction(args: {
  cwd: string
  config: InfinitiConfig
  messages: PersistedMessage[]
  controller?: AutoCompactionController | null
  compacting?: boolean
  onCompactedBase?: (compactedBase: PersistedMessage[], originalBase: PersistedMessage[]) => void
  ui: AutoCompactionUi
}): boolean {
  const cs = resolvedCompactionSettings(args.config)
  const beforeTokens = estimateMessagesTokens(args.messages)
  if (args.compacting) {
    agentDebug('[auto-compact] skip: already running', { messages: args.messages.length, tokens: beforeTokens })
    return false
  }
  if (isAlreadyCompactedNearTailLimit(args.messages, cs.minTailMessages)) {
    agentDebug('[auto-compact] skip: already compacted near tail limit', {
      messages: args.messages.length,
      tokens: beforeTokens,
      minTailMessages: cs.minTailMessages,
    })
    return false
  }
  if (cs.autoThresholdTokens <= 0 || beforeTokens < cs.autoThresholdTokens) {
    agentDebug('[auto-compact] skip: threshold not reached', {
      messages: args.messages.length,
      tokens: beforeTokens,
      threshold: cs.autoThresholdTokens,
    })
    return false
  }

  agentDebug('[auto-compact] start', {
    messages: args.messages.length,
    tokens: beforeTokens,
    threshold: cs.autoThresholdTokens,
    minTailMessages: cs.minTailMessages,
    maxToolSnippetChars: cs.maxToolSnippetChars,
    controller: args.controller ? 'subconscious' : 'direct',
  })
  args.ui.setCompacting(true)
  args.ui.setNotice('历史较长，正在自动压缩上下文（非流式）…')
  try {
    const compactPromise = args.controller
      ? args.controller.compactSessionAsync({
          messages: args.messages,
          minTailMessages: cs.minTailMessages,
          maxToolSnippetChars: cs.maxToolSnippetChars,
          preCompactHook: cs.preCompactHook,
        })
      : (async () => {
          if (args.messages.length > 0) await archiveSession(args.cwd, args.messages).catch(() => {})
          const next = await compactSessionMessages({
            config: args.config,
            cwd: args.cwd,
            messages: args.messages,
            minTailMessages: cs.minTailMessages,
            maxToolSnippetChars: cs.maxToolSnippetChars,
            preCompactHook: cs.preCompactHook,
          })
          await saveSession(args.cwd, next)
          return next
        })()
    void compactPromise
      .then(async (next) => {
        args.onCompactedBase?.(next, args.messages)
        const merged = mergeCompactedPrefixWithLatest(next, args.messages, args.ui.getMessages?.())
        await saveSession(args.cwd, merged)
        agentDebug('[auto-compact] complete', {
          beforeMessages: args.messages.length,
          compactedMessages: next.length,
          mergedMessages: merged.length,
          beforeTokens,
          compactedTokens: estimateMessagesTokens(next),
          mergedTokens: estimateMessagesTokens(merged),
          appendedMessages: Math.max(0, merged.length - next.length),
        })
        args.ui.setMessages(merged)
        args.ui.setNotice('已自动后台压缩上下文')
        args.ui.clearNoticeLater(5000)
      })
      .catch((e: unknown) => {
        agentDebug('[auto-compact] failed', formatChatError(e))
        args.ui.setError(formatChatError(e))
        args.ui.setNotice(null)
      })
      .finally(() => args.ui.setCompacting(false))
    args.ui.setNotice('历史较长，已提交后台压缩；本轮继续使用当前上下文…')
    return true
  } catch (e: unknown) {
    agentDebug('[auto-compact] failed synchronously', formatChatError(e))
    args.ui.setError(formatChatError(e))
    args.ui.setNotice(null)
    args.ui.setCompacting(false)
    args.ui.setBusy(false)
    return true
  }
}

function isAlreadyCompactedNearTailLimit(messages: PersistedMessage[], minTailMessages: number): boolean {
  const first = messages[0]
  if (first?.role !== 'user' || !first.content.includes('## [会话压缩摘要]')) {
    return false
  }
  const minKeep = Math.max(4, minTailMessages)
  return messages.length <= minKeep + 6
}

export function mergeCompactedPrefixWithLatest(
  compactedBase: PersistedMessage[],
  originalBase: PersistedMessage[],
  latest: PersistedMessage[] | undefined,
): PersistedMessage[] {
  if (!latest || latest.length <= originalBase.length) return compactedBase
  if (!startsWithSameMessages(latest, originalBase)) return latest
  return [...compactedBase, ...latest.slice(originalBase.length)]
}

function startsWithSameMessages(messages: PersistedMessage[], prefix: PersistedMessage[]): boolean {
  if (messages.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (messages[i] !== prefix[i] && JSON.stringify(messages[i]) !== JSON.stringify(prefix[i])) {
      return false
    }
  }
  return true
}
