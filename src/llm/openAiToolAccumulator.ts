import type { NormalizedToolCall } from './toolExecutionMessages.js'

export type OpenAiToolDelta = {
  index?: number
  id?: string
  function?: {
    name?: string
    arguments?: string
  }
}

type AccumulatedToolCall = {
  id: string
  name: string
  arguments: string
}

export class OpenAiToolAccumulator {
  private readonly calls = new Map<number, AccumulatedToolCall>()

  add(delta: OpenAiToolDelta): void {
    const index = typeof delta.index === 'number' ? delta.index : 0
    const cur = this.calls.get(index) ?? { id: '', name: '', arguments: '' }
    if (delta.id) cur.id = delta.id
    if (delta.function?.name) cur.name = delta.function.name
    if (delta.function?.arguments) cur.arguments += delta.function.arguments
    this.calls.set(index, cur)
  }

  toToolCalls(): NormalizedToolCall[] {
    return [...this.calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v)
      .filter((v) => v.id && v.name)
      .map((v) => ({
        id: v.id,
        name: v.name,
        argumentsJson: v.arguments || '{}',
      }))
  }
}
