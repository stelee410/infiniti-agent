import type { PersistedMessage } from '../llm/persisted.js'

export type RollMessagesResult = {
  messages: PersistedMessage[]
  removed: number
  layers: number
}

export function rollMessages(messages: PersistedMessage[], layers = 1): RollMessagesResult {
  const requested = Math.max(1, Math.floor(Number.isFinite(layers) ? layers : 1))
  let next = [...messages]
  let removed = 0
  let done = 0

  for (let i = 0; i < requested; i++) {
    const assistantIdx = findLastAssistantOutput(next)
    if (assistantIdx < 0) break
    const start = findLayerStart(next, assistantIdx)
    removed += next.length - start
    next = next.slice(0, start)
    done++
  }

  return { messages: next, removed, layers: done }
}

function findLastAssistantOutput(messages: PersistedMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') return i
  }
  return -1
}

function findPreviousAssistantOutput(messages: PersistedMessage[], start: number): number {
  for (let i = start; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') return i
  }
  return -1
}

function findLayerStart(messages: PersistedMessage[], assistantIdx: number): number {
  let current = assistantIdx
  while (true) {
    const prevAssistantIdx = findPreviousAssistantOutput(messages, current - 1)
    if (prevAssistantIdx < 0) return 0
    const prev = messages[prevAssistantIdx]
    if (prev?.role === 'assistant' && assistantToolResultsContinueAfter(messages, prevAssistantIdx, current)) {
      current = prevAssistantIdx
      continue
    }
    return prevAssistantIdx + 1
  }
}

function assistantToolResultsContinueAfter(messages: PersistedMessage[], assistantIdx: number, untilIdx: number): boolean {
  const assistant = messages[assistantIdx]
  if (assistant?.role !== 'assistant' || !assistant.toolCalls?.length) return false
  const needed = new Set(assistant.toolCalls.map((tc) => tc.id))
  for (let i = assistantIdx + 1; i <= untilIdx; i++) {
    const m = messages[i]
    if (m?.role === 'tool' && needed.has(m.toolCallId)) {
      return true
    }
    if (m?.role === 'assistant') {
      break
    }
  }
  return false
}
