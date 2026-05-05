import type { DreamEpisode, DeepDreamResult, RemDreamInsight, DreamPromptContext, DreamDiary } from './types.js'
import type { StateDelta } from '../subconscious/types.js'

export function runDeepDream(opts: {
  episode: DreamEpisode
  rem: RemDreamInsight
  now?: Date
}): DeepDreamResult {
  const now = opts.now ?? new Date()
  const save = opts.rem.memoryCandidates.filter((c) => c.importance >= 0.75 && c.confidence >= 0.7)
  const soft = opts.rem.memoryCandidates.filter((c) => c.importance >= 0.55 && !(c.importance >= 0.75 && c.confidence >= 0.7))
  const discard = opts.rem.memoryCandidates.filter((c) => c.importance < 0.55)
  const currentObjective = opts.rem.longHorizonObjectiveCandidate?.objective
  const diary: DreamDiary = {
    id: `diary_${now.toISOString().replace(/[:.]/g, '-')}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now.toISOString(),
    title: 'Jess 的梦境笔记',
    summary: opts.episode.summary,
    whatHappened: [
      ...opts.episode.keyFacts,
      ...opts.episode.projectSignals,
      ...opts.episode.userPreferences,
    ].slice(0, 8),
    whatIUnderstood: [
      ...opts.rem.projectUnderstanding,
      opts.rem.selfReflection,
    ].filter(Boolean).slice(0, 8),
    memoriesChanged: [
      ...save.map((c) => `长期记忆：${c.content}`),
      ...soft.map((c) => `软记忆：${c.content}`),
      ...discard.map((c) => `丢弃/仅保留在梦境：${c.content}`),
    ].slice(0, 12),
    metaStateChanges: metaStateNotes(opts.rem),
    ...(currentObjective ? { currentObjective } : {}),
    ...(opts.rem.optionalMessageToUser ? { messageToUser: opts.rem.optionalMessageToUser } : {}),
    visibleToUser: true,
  }
  const promptContext: DreamPromptContext = {
    updatedAt: now.toISOString(),
    ...(currentObjective ? { longHorizonObjective: currentObjective } : {}),
    recentInsight: opts.rem.selfReflection,
    relevantStableMemories: save.map((c) => c.content).slice(0, 5),
    behaviorGuidance: opts.rem.behaviorGuidance.slice(0, 6),
    unresolvedThreads: opts.rem.unresolvedThreads.slice(0, 5),
    cautions: [
      'Dream insights are guidance, not hard facts.',
      'Low-confidence hypotheses must be verified before becoming long-term memory.',
    ],
  }
  return {
    memoriesCreated: save.map((c) => c.content),
    memoriesUpdated: [],
    memoriesDiscarded: discard.map((c) => c.content),
    fuzzyMemoriesCreated: soft.map((c) => c.content),
    metaStatePatch: metaStatePatchFromRem(opts.rem),
    ...(opts.rem.longHorizonObjectiveCandidate ? { longHorizonObjective: opts.rem.longHorizonObjectiveCandidate } : {}),
    dreamDiary: diary,
    promptContext,
  }
}

function metaStateNotes(rem: RemDreamInsight): string[] {
  const notes: string[] = []
  if (rem.relationshipSignals.length) {
    notes.push(`关系信号：${rem.relationshipSignals.slice(0, 3).join('；')}`)
  }
  if (rem.emotionalTrend.length) {
    notes.push(`情绪趋势：${rem.emotionalTrend.slice(0, 3).join('；')}`)
  }
  if (!notes.length) notes.push('本次梦境未对长期关系状态做明显调整。')
  return notes
}

function metaStatePatchFromRem(rem: RemDreamInsight): StateDelta {
  const patch: StateDelta = {}
  if (rem.projectUnderstanding.length || rem.behaviorGuidance.length) {
    patch.engagement = 0.02
    patch.speechStyle = 'focused'
  }
  if (rem.relationshipSignals.length) {
    patch.trust = 0.01
    patch.respect = 0.01
  }
  const emotional = rem.emotionalTrend.join(' ')
  if (/焦虑|紧张|挫败|生气|烦|urgent|frustrat|angry|tension/i.test(emotional)) {
    patch.tension = 0.02
    patch.speechStyle = 'careful'
  }
  return patch
}
