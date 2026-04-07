import type { InfinitiConfig } from '../config/types.js'

export const DEFAULT_MIN_TAIL_MESSAGES = 16
export const DEFAULT_MAX_TOOL_SNIPPET_CHARS = 4000

export function resolvedCompactionSettings(config: InfinitiConfig): {
  autoThresholdTokens: number
  minTailMessages: number
  maxToolSnippetChars: number
  preCompactHook: string | undefined
} {
  const c = config.compaction
  return {
    autoThresholdTokens:
      typeof c?.autoThresholdTokens === 'number' && c.autoThresholdTokens >= 0
        ? c.autoThresholdTokens
        : 0,
    minTailMessages: Math.max(
      4,
      c?.minTailMessages ?? DEFAULT_MIN_TAIL_MESSAGES,
    ),
    maxToolSnippetChars: Math.max(
      500,
      c?.maxToolSnippetChars ?? DEFAULT_MAX_TOOL_SNIPPET_CHARS,
    ),
    preCompactHook: c?.preCompactHook?.trim() || undefined,
  }
}
