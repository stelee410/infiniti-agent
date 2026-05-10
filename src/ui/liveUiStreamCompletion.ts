import type { PersistedMessage } from '../llm/persisted.js'

export type AssistantStreamCompletionTarget = {
  sendAssistantStream(fullRaw: string, reset?: boolean, done?: boolean): void
}

export function sendLiveUiAssistantDone(
  liveUi: AssistantStreamCompletionTarget | null | undefined,
  messages: PersistedMessage[],
): void {
  if (!liveUi) return

  const lastMsg = messages[messages.length - 1]
  if (lastMsg?.role !== 'assistant' || typeof lastMsg.content !== 'string') return

  liveUi.sendAssistantStream(lastMsg.content, false, true)
}
