import type { InfinitiConfig } from '../config/types.js'
import { compactSessionMessages } from '../llm/compactSession.js'
import { resolvedCompactionSettings } from '../llm/compactionSettings.js'
import { estimateMessagesTokens } from '../llm/estimateTokens.js'
import type { PersistedMessage } from '../llm/persisted.js'
import { archiveSession } from '../session/archive.js'
import { saveSession } from '../session/file.js'
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
  clearNoticeLater(ms: number): void
}

export function maybeStartAutoCompaction(args: {
  cwd: string
  config: InfinitiConfig
  messages: PersistedMessage[]
  controller?: AutoCompactionController | null
  ui: AutoCompactionUi
}): boolean {
  const cs = resolvedCompactionSettings(args.config)
  if (cs.autoThresholdTokens <= 0 || estimateMessagesTokens(args.messages) < cs.autoThresholdTokens) {
    return false
  }

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
      .then((next) => {
        args.ui.setMessages(next)
        args.ui.setNotice('已自动后台压缩上下文')
        args.ui.clearNoticeLater(5000)
      })
      .catch((e: unknown) => {
        args.ui.setError(formatChatError(e))
        args.ui.setNotice(null)
      })
      .finally(() => args.ui.setCompacting(false))
    args.ui.setNotice('历史较长，已提交后台压缩；本轮继续使用当前上下文…')
    return true
  } catch (e: unknown) {
    args.ui.setError(formatChatError(e))
    args.ui.setNotice(null)
    args.ui.setCompacting(false)
    args.ui.setBusy(false)
    return true
  }
}
