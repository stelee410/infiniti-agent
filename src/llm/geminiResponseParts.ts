export type GeminiResponseToolCall = {
  name: string
  args: Record<string, unknown>
}

export type GeminiResponseParts = {
  mergedText: string | null
  calls: GeminiResponseToolCall[]
}

export function extractGeminiResponseParts(parts: unknown[]): GeminiResponseParts {
  const textChunks: string[] = []
  const calls: GeminiResponseToolCall[] = []
  for (const raw of parts) {
    const part = raw as { text?: unknown; functionCall?: { name?: unknown; args?: unknown } }
    if (typeof part.text === 'string') {
      textChunks.push(part.text)
    }
    if (typeof part.functionCall?.name === 'string' && part.functionCall.name) {
      calls.push({
        name: part.functionCall.name,
        args:
          part.functionCall.args && typeof part.functionCall.args === 'object' && !Array.isArray(part.functionCall.args)
            ? part.functionCall.args as Record<string, unknown>
            : {},
      })
    }
  }
  return {
    mergedText: textChunks.join('').trim() || null,
    calls,
  }
}
