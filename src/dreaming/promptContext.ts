import type { DreamPromptContext } from './types.js'

export function dreamPromptContextToPromptBlock(context: DreamPromptContext | null): string {
  if (!context) return ''
  const lines = ['## Dream Context', '', `updated_at: ${context.updatedAt}`]
  if (context.longHorizonObjective?.trim()) {
    lines.push('', 'Long-horizon objective:', context.longHorizonObjective.trim())
  }
  if (context.recentInsight?.trim()) {
    lines.push('', 'Recent insight:', context.recentInsight.trim())
  }
  if (context.relevantStableMemories.length) {
    lines.push('', 'Relevant stable memories:', ...context.relevantStableMemories.slice(0, 5).map((m) => `- ${m.slice(0, 500)}`))
  }
  if (context.behaviorGuidance.length) {
    lines.push('', 'Behavior guidance:', ...context.behaviorGuidance.slice(0, 6).map((g) => `- ${g.slice(0, 500)}`))
  }
  if (context.unresolvedThreads.length) {
    lines.push('', 'Unresolved threads:', ...context.unresolvedThreads.slice(0, 5).map((t) => `- ${t.slice(0, 500)}`))
  }
  if (context.creativeHint?.trim()) {
    lines.push('', 'Creative hint:', context.creativeHint.trim().slice(0, 500))
  }
  if (context.cautions.length) {
    lines.push('', 'Cautions:', ...context.cautions.slice(0, 5).map((c) => `- ${c.slice(0, 500)}`))
  }
  return lines.join('\n').slice(0, 5000)
}
