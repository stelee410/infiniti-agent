import type { InfinitiConfig } from '../config/types.js'
import { oneShotTextCompletion } from '../llm/oneShotCompletion.js'
import { REM_DREAM_SYSTEM } from './prompts.js'
import { parseJsonObject } from './json.js'
import { calculateImportance, normalizeCandidate } from './scoring.js'
import type {
  DreamDiary,
  DreamEpisode,
  DreamMemoryCandidate,
  LongHorizonObjective,
  RemDreamInsight,
} from './types.js'
import type { MetaState } from '../subconscious/types.js'

type RemDreamJson = Partial<Omit<RemDreamInsight, 'memoryCandidates' | 'longHorizonObjectiveCandidate'>> & {
  memoryCandidates?: Array<Partial<DreamMemoryCandidate>>
  longHorizonObjectiveCandidate?: Partial<LongHorizonObjective>
}

export async function runRemDream(opts: {
  config: InfinitiConfig
  profile?: string
  episode: DreamEpisode
  existingLongTermMemories: string[]
  existingFuzzyMemories: string[]
  metaState: MetaState
  recentDreams: DreamDiary[]
  now?: Date
}): Promise<RemDreamInsight> {
  const now = opts.now ?? new Date()
  const fallback = fallbackRem(opts.episode, now)
  try {
    const raw = await oneShotTextCompletion({
      config: opts.config,
      profile: opts.profile,
      system: REM_DREAM_SYSTEM,
      user: JSON.stringify({
        episode: opts.episode,
        existingLongTermMemories: opts.existingLongTermMemories.slice(-20),
        existingFuzzyMemories: opts.existingFuzzyMemories.slice(-20),
        metaState: opts.metaState,
        recentDreams: opts.recentDreams.map((d) => ({
          summary: d.summary,
          whatIUnderstood: d.whatIUnderstood,
          currentObjective: d.currentObjective,
        })),
      }, null, 2),
      maxOutTokens: 1600,
      temperature: 0.4,
      topP: 0.9,
    })
    const parsed = parseJsonObject<RemDreamJson>(raw)
    if (!parsed) return fallback
    const objective = normalizeObjective(parsed.longHorizonObjectiveCandidate, now)
    return {
      repeatedPatterns: cleanList(parsed.repeatedPatterns, fallback.repeatedPatterns),
      projectUnderstanding: cleanList(parsed.projectUnderstanding, fallback.projectUnderstanding),
      relationshipSignals: cleanList(parsed.relationshipSignals, fallback.relationshipSignals),
      emotionalTrend: cleanList(parsed.emotionalTrend, fallback.emotionalTrend),
      unresolvedThreads: cleanList(parsed.unresolvedThreads, fallback.unresolvedThreads),
      memoryCandidates: normalizeCandidates(parsed.memoryCandidates, fallback.memoryCandidates),
      selfReflection: clean(parsed.selfReflection) || fallback.selfReflection,
      behaviorGuidance: cleanList(parsed.behaviorGuidance, fallback.behaviorGuidance),
      ...(objective ? { longHorizonObjectiveCandidate: objective } : fallback.longHorizonObjectiveCandidate ? { longHorizonObjectiveCandidate: fallback.longHorizonObjectiveCandidate } : {}),
      ...(clean(parsed.optionalMessageToUser) ? { optionalMessageToUser: clean(parsed.optionalMessageToUser) } : {}),
    }
  } catch {
    return fallback
  }
}

function fallbackRem(episode: DreamEpisode, now: Date): RemDreamInsight {
  const projectUnderstanding = episode.projectSignals.length
    ? [`当前重点集中在：${episode.projectSignals.slice(0, 3).join('；')}`]
    : episode.summary ? [episode.summary] : []
  const stable = [
    ...episode.userPreferences.map((content) => candidate('user_preference', content, episode, 0.85, 0.82)),
    ...episode.projectSignals.map((content) => candidate('project_context', content, episode, 0.72, 0.72)),
    ...episode.keyFacts.map((content) => candidate('project_context', content, episode, 0.7, 0.72)),
  ]
  const objective = projectUnderstanding[0]
    ? {
        objective: `继续帮助用户推进：${projectUnderstanding[0].replace(/^当前重点集中在：/, '').slice(0, 120)}`,
        reason: 'Dream Runtime 从最近 episode 中识别到持续项目方向。',
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
        confidence: 0.68,
      }
    : undefined
  return {
    repeatedPatterns: episode.topics.slice(0, 5),
    projectUnderstanding,
    relationshipSignals: [],
    emotionalTrend: episode.emotionalSignals,
    unresolvedThreads: episode.unresolvedQuestions,
    memoryCandidates: stable.slice(0, 10),
    selfReflection: projectUnderstanding[0]
      ? `这次梦境把最近对话理解为一个持续推进的项目片段：${projectUnderstanding[0]}。`
      : '这次梦境没有发现足够稳定的新模式。',
    behaviorGuidance: [
      '优先保持概念边界清晰。',
      '只把明确表达或高置信度项目事实写入长期记忆。',
      '将低置信度联想保留为梦境理解，不当作事实。',
    ],
    ...(objective ? { longHorizonObjectiveCandidate: objective } : {}),
  }
}

function candidate(
  type: DreamMemoryCandidate['type'],
  content: string,
  episode: DreamEpisode,
  explicitness: number,
  confidence: number,
): DreamMemoryCandidate {
  const recurrence = episode.topics.length >= 3 ? 0.65 : 0.45
  const futureUsefulness = type === 'user_preference' ? 0.82 : 0.72
  const emotionalWeight = type === 'relationship_signal' ? 0.7 : 0.3
  const projectRelevance = type === 'project_context' || type === 'design_decision' ? 0.85 : 0.55
  const importance = calculateImportance({ explicitness, recurrence, futureUsefulness, emotionalWeight, projectRelevance })
  return normalizeCandidate({
    id: `cand_${Math.random().toString(36).slice(2, 10)}`,
    type,
    content,
    evidence: episode.rawEventRefs.length ? episode.rawEventRefs : [episode.id],
    explicitness,
    recurrence,
    futureUsefulness,
    emotionalWeight,
    projectRelevance,
    importance,
    confidence,
    action: importance >= 0.75 && confidence >= 0.7 ? 'save' : importance >= 0.55 ? 'soft_save' : 'confirm_later',
    reason: '由 Light Dream episode 中的稳定信号生成。',
  })
}

function normalizeCandidates(value: unknown, fallback: DreamMemoryCandidate[]): DreamMemoryCandidate[] {
  if (!Array.isArray(value)) return fallback
  const out = value
    .map((item): DreamMemoryCandidate | null => {
      if (!item || typeof item !== 'object') return null
      const raw = item as Partial<DreamMemoryCandidate>
      const content = clean(raw.content)
      if (!content) return null
      return normalizeCandidate({
        id: raw.id || `cand_${Math.random().toString(36).slice(2, 10)}`,
        type: isCandidateType(raw.type) ? raw.type : 'project_context',
        content,
        evidence: Array.isArray(raw.evidence) ? raw.evidence.map(clean).filter(Boolean).slice(0, 8) : [],
        explicitness: num(raw.explicitness, 0.6),
        recurrence: num(raw.recurrence, 0.4),
        futureUsefulness: num(raw.futureUsefulness, 0.6),
        emotionalWeight: num(raw.emotionalWeight, 0.2),
        projectRelevance: num(raw.projectRelevance, 0.6),
        importance: num(raw.importance, 0),
        confidence: num(raw.confidence, 0.55),
        action: isAction(raw.action) ? raw.action : 'confirm_later',
        reason: clean(raw.reason) || 'REM Dream candidate',
      })
    })
    .filter((item): item is DreamMemoryCandidate => Boolean(item))
  return out.length ? out.slice(0, 16) : fallback
}

function normalizeObjective(value: unknown, now: Date): LongHorizonObjective | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Partial<LongHorizonObjective>
  const objective = clean(raw.objective)
  if (!objective) return undefined
  return {
    objective,
    reason: clean(raw.reason) || 'REM Dream objective candidate',
    createdAt: clean(raw.createdAt) || now.toISOString(),
    expiresAt: clean(raw.expiresAt) || new Date(now.getTime() + 7 * 86_400_000).toISOString(),
    confidence: num(raw.confidence, 0.65),
  }
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 800) : ''
}

function cleanList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  const out = value.map(clean).filter(Boolean)
  return out.length ? out.slice(0, 12) : fallback
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function isCandidateType(value: unknown): value is DreamMemoryCandidate['type'] {
  return typeof value === 'string' && [
    'user_preference',
    'project_context',
    'relationship_signal',
    'design_decision',
    'personal_fact',
    'long_horizon_objective',
  ].includes(value)
}

function isAction(value: unknown): value is DreamMemoryCandidate['action'] {
  return typeof value === 'string' && ['save', 'merge', 'soft_save', 'discard', 'confirm_later'].includes(value)
}
