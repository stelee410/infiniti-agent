import type { MetaState, StateDelta } from '../subconscious/types.js'

export type DreamMode = 'light' | 'rem' | 'deep' | 'full'
export type DreamSource = 'heartbeat' | 'schedule' | 'manual' | 'compact' | 'session_end'

export type DreamRunStatus = 'running' | 'completed' | 'failed' | 'skipped'

export type DreamRun = {
  id: string
  version: 1
  mode: DreamMode
  source: DreamSource
  startedAt: string
  completedAt?: string
  status: DreamRunStatus
  reason: string
  error?: string
  episodeId?: string
  diaryId?: string
}

export type DreamEpisode = {
  id: string
  createdAt: string
  source: DreamSource
  summary: string
  topics: string[]
  keyFacts: string[]
  userPreferences: string[]
  projectSignals: string[]
  emotionalSignals: string[]
  unresolvedQuestions: string[]
  rawEventRefs: string[]
}

export type DreamMemoryCandidate = {
  id: string
  type:
    | 'user_preference'
    | 'project_context'
    | 'relationship_signal'
    | 'design_decision'
    | 'personal_fact'
    | 'long_horizon_objective'
  content: string
  evidence: string[]
  explicitness: number
  recurrence: number
  futureUsefulness: number
  emotionalWeight: number
  projectRelevance: number
  importance: number
  confidence: number
  action: 'save' | 'merge' | 'soft_save' | 'discard' | 'confirm_later'
  reason: string
}

export type LongHorizonObjective = {
  objective: string
  reason: string
  createdAt: string
  expiresAt: string
  confidence: number
}

export type RemDreamInsight = {
  repeatedPatterns: string[]
  projectUnderstanding: string[]
  relationshipSignals: string[]
  emotionalTrend: string[]
  unresolvedThreads: string[]
  memoryCandidates: DreamMemoryCandidate[]
  selfReflection: string
  behaviorGuidance: string[]
  longHorizonObjectiveCandidate?: LongHorizonObjective
  optionalMessageToUser?: string
}

export type MetaStatePatch = StateDelta & {
  persona?: {
    warmth?: number
    humor?: number
    proactiveness?: number
    formality?: number
  }
}

export type DreamDiary = {
  id: string
  createdAt: string
  title: string
  summary: string
  whatHappened: string[]
  whatIUnderstood: string[]
  memoriesChanged: string[]
  metaStateChanges: string[]
  currentObjective?: string
  messageToUser?: string
  visibleToUser: boolean
}

export type DreamPromptContext = {
  updatedAt: string
  longHorizonObjective?: string
  recentInsight?: string
  relevantStableMemories: string[]
  behaviorGuidance: string[]
  unresolvedThreads: string[]
  cautions: string[]
}

export type DeepDreamResult = {
  memoriesCreated: string[]
  memoriesUpdated: string[]
  memoriesDiscarded: string[]
  fuzzyMemoriesCreated: string[]
  metaStatePatch: MetaStatePatch
  longHorizonObjective?: LongHorizonObjective
  dreamDiary: DreamDiary
  promptContext: DreamPromptContext
}

export type DreamInputs = {
  recentTranscript: string
  historyTranscript: string
  metaState: MetaState
  existingLongTermMemories: string[]
  existingFuzzyMemories: string[]
  recentDreams: DreamDiary[]
}
