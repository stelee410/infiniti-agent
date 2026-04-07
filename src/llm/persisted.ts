export type ToolCallSpec = {
  id: string
  name: string
  argumentsJson: string
}

export type PersistedMessage =
  | { role: 'user'; content: string }
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
