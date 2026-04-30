import type { PersistedMessage } from './persisted.js'

export type NormalizedToolCall = {
  id: string
  name: string
  argumentsJson: string
}

export type PendingToolExecution = NormalizedToolCall & {
  resultPromise: Promise<string>
}

export function appendAssistantToolCalls(
  messages: PersistedMessage[],
  content: string | null,
  calls: NormalizedToolCall[],
): void {
  messages.push({
    role: 'assistant',
    content,
    toolCalls: calls.map((call) => ({
      id: call.id,
      name: call.name,
      argumentsJson: call.argumentsJson || '{}',
    })),
  })
}

export async function appendPendingToolResults(
  messages: PersistedMessage[],
  pending: PendingToolExecution[],
  onError?: (toolError: unknown, tool: PendingToolExecution) => string,
): Promise<void> {
  for (const tool of pending) {
    let content: string
    try {
      content = await tool.resultPromise
    } catch (e) {
      if (!onError) throw e
      content = onError(e, tool)
    }
    appendToolResult(messages, tool, content)
  }
}

export function appendToolResult(
  messages: PersistedMessage[],
  call: Pick<NormalizedToolCall, 'id' | 'name'>,
  content: string,
): void {
  messages.push({
    role: 'tool',
    toolCallId: call.id,
    name: call.name,
    content,
  })
}

export function failedToolResultJson(status: string, toolError: unknown): string {
  return JSON.stringify({
    ok: false,
    status,
    error: toolError instanceof Error ? toolError.message : String(toolError),
  })
}
