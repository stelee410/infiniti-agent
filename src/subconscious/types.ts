export type MetaEmotion = 'neutral' | 'happy' | 'sad' | 'angry' | 'surprised' | 'thinking'

export type MetaState = {
  emotion: MetaEmotion
  emotionIntensity: number
  mood: number
  affinity: number
  trust: number
  intimacy: number
  respect: number
  tension: number
  confidence: number
  engagement: number
  speechStyle: string
  gesture?: string
  updatedAt: string
}

export type InputAnalysis = {
  sentiment: number
  aggression: number
  frustration: number
  praise: number
  urgency: number
  intimacySignal: number
  correctionSignal: number
  taskFocus: number
}

export type AgentResponseAnalysis = {
  warmth: number
  trustSignal: number
  intimacySignal: number
  respectSignal: number
  caution: number
  conflict: number
  apology: number
}

export type StateDelta = {
  emotion?: {
    type: MetaEmotion
    intensityDelta?: number
    absolute?: number
  }
  mood?: number
  affinity?: number
  trust?: number
  intimacy?: number
  respect?: number
  tension?: number
  confidence?: number
  engagement?: number
  speechStyle?: string
  gesture?: string
}

export type AvatarCommand = {
  expression: {
    name: MetaEmotion | 'warm' | 'careful'
    intensity: number
  }
  gesture?: string
  speech?: {
    speaking: boolean
    text?: string
    phoneme?: string
  }
}

export type SubconsciousMemorySource = {
  type: 'recent' | 'compact' | 'heartbeat' | 'history' | 'manual'
  ref?: string
  at: string
}

export type SubconsciousMemoryEntry = {
  id: string
  text: string
  confidence: number
  reinforcement: number
  sources: SubconsciousMemorySource[]
  firstSeenAt: string
  lastSeenAt: string
  validFrom?: string
  validUntil?: string
  topic?: string
}

export type SubconsciousStore = {
  version: 1
  metadata: {
    lastDurableConsolidationAt?: string
    lastHistoryScanAt?: string
    lastHistoryScanTopic?: string
    lastFuzzyDecayAt?: string
    lastLongTermCompressionAt?: string
    lastDocumentMemorySyncAt?: string
    lastRetrievedMemoryIds?: string[]
    lastHeartbeatAt?: string
    lastHeartbeatDurationMs?: number
    historyScanRunning?: boolean
    lastHistoryScanError?: string
  }
  state: MetaState
  memory: {
    project: string[]
    userPreference: string[]
    persona: string[]
    fuzzy: SubconsciousMemoryEntry[]
    longTerm: SubconsciousMemoryEntry[]
  }
  recent: Array<{
    at: string
    source: 'user' | 'assistant'
    text: string
    analysis: InputAnalysis | AgentResponseAnalysis
    delta: StateDelta
  }>
}
