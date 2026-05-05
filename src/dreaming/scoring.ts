import type { DreamMemoryCandidate } from './types.js'

export function calculateImportance(input: {
  explicitness: number
  recurrence: number
  futureUsefulness: number
  emotionalWeight: number
  projectRelevance: number
}): number {
  return clamp01(
    input.explicitness * 0.3
    + input.recurrence * 0.25
    + input.futureUsefulness * 0.25
    + input.emotionalWeight * 0.1
    + input.projectRelevance * 0.1,
  )
}

export function normalizeCandidate(candidate: DreamMemoryCandidate): DreamMemoryCandidate {
  const explicitness = clamp01(candidate.explicitness)
  const recurrence = clamp01(candidate.recurrence)
  const futureUsefulness = clamp01(candidate.futureUsefulness)
  const emotionalWeight = clamp01(candidate.emotionalWeight)
  const projectRelevance = clamp01(candidate.projectRelevance)
  const importance = clamp01(
    candidate.importance || calculateImportance({
      explicitness,
      recurrence,
      futureUsefulness,
      emotionalWeight,
      projectRelevance,
    }),
  )
  const confidence = clamp01(candidate.confidence)
  return {
    ...candidate,
    explicitness,
    recurrence,
    futureUsefulness,
    emotionalWeight,
    projectRelevance,
    importance,
    confidence,
    action: candidate.action || actionForScores(importance, confidence),
  }
}

export function actionForScores(
  importance: number,
  confidence: number,
): DreamMemoryCandidate['action'] {
  if (importance >= 0.75 && confidence >= 0.7) return 'save'
  if (importance >= 0.55) return 'soft_save'
  if (importance >= 0.35) return 'confirm_later'
  return 'discard'
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}
