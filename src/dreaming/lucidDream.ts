import type { InfinitiConfig } from '../config/types.js'
import { oneShotTextCompletion } from '../llm/oneShotCompletion.js'
import { parseJsonObject } from './json.js'
import { LUCID_DREAM_SYSTEM } from './prompts.js'
import type { DreamEpisode, LucidDreamIdea, LucidDreamInsight, RemDreamInsight } from './types.js'
import { clamp01 } from './scoring.js'

type LucidDreamJson = {
  creativeInsights?: Array<Partial<Omit<LucidDreamIdea, 'id'>>>
  nextQuestions?: string[]
  possibleExperiments?: string[]
  messageToUser?: string
}

export async function runLucidDream(opts: {
  config: InfinitiConfig
  profile?: string
  episode: DreamEpisode
  rem: RemDreamInsight
}): Promise<LucidDreamInsight> {
  const fallback = fallbackLucidDream(opts.episode, opts.rem)
  try {
    const raw = await oneShotTextCompletion({
      config: opts.config,
      profile: opts.profile,
      system: LUCID_DREAM_SYSTEM,
      user: JSON.stringify({
        episode: opts.episode,
        rem: opts.rem,
        guardrails: [
          'Creative insights are not facts.',
          'Do not write creative insights into long-term factual memory.',
          'Every idea must be grounded in known context.',
        ],
      }, null, 2),
      maxOutTokens: 1400,
      temperature: 0.85,
      topP: 0.95,
    })
    const parsed = parseJsonObject<LucidDreamJson>(raw)
    if (!parsed) return fallback
    const ideas = normalizeIdeas(parsed.creativeInsights)
    return {
      creativeInsights: ideas.length ? ideas : fallback.creativeInsights,
      nextQuestions: cleanList(parsed.nextQuestions, fallback.nextQuestions),
      possibleExperiments: cleanList(parsed.possibleExperiments, fallback.possibleExperiments),
      ...(clean(parsed.messageToUser) ? { messageToUser: clean(parsed.messageToUser) } : fallback.messageToUser ? { messageToUser: fallback.messageToUser } : {}),
    }
  } catch {
    return fallback
  }
}

function fallbackLucidDream(episode: DreamEpisode, rem: RemDreamInsight): LucidDreamInsight {
  const base = rem.unresolvedThreads[0] || episode.unresolvedQuestions[0] || episode.projectSignals[0] || episode.summary
  if (!base) {
    return { creativeInsights: [], nextQuestions: [], possibleExperiments: [] }
  }
  const idea: LucidDreamIdea = {
    id: newIdeaId(),
    idea: `可以把下一次梦境聚焦在一个未解决问题上，而不是平均整理全部内容：${base.slice(0, 120)}`,
    type: 'experiment',
    groundedIn: [base.slice(0, 180)],
    usefulness: 0.72,
    confidence: 0.62,
    shouldTellUser: true,
  }
  return {
    creativeInsights: [idea],
    nextQuestions: rem.unresolvedThreads.slice(0, 3),
    possibleExperiments: [idea.idea],
    messageToUser: idea.idea,
  }
}

function normalizeIdeas(value: unknown): LucidDreamIdea[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item): LucidDreamIdea | null => {
      if (!item || typeof item !== 'object') return null
      const raw = item as Partial<Omit<LucidDreamIdea, 'id'>>
      const idea = clean(raw.idea)
      if (!idea) return null
      return {
        id: newIdeaId(),
        idea,
        type: isIdeaType(raw.type) ? raw.type : 'architecture_idea',
        groundedIn: cleanList(raw.groundedIn, []).slice(0, 5),
        usefulness: clamp01(typeof raw.usefulness === 'number' ? raw.usefulness : 0.5),
        confidence: clamp01(typeof raw.confidence === 'number' ? raw.confidence : 0.5),
        shouldTellUser: raw.shouldTellUser === true,
      }
    })
    .filter((item): item is LucidDreamIdea => Boolean(item))
    .sort((a, b) => b.usefulness - a.usefulness)
    .slice(0, 5)
}

function isIdeaType(value: unknown): value is LucidDreamIdea['type'] {
  return typeof value === 'string' && [
    'architecture_idea',
    'product_idea',
    'ux_idea',
    'risk_warning',
    'question_to_ask',
    'experiment',
  ].includes(value)
}

function cleanList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  const out = value.map(clean).filter(Boolean)
  return out.length ? out.slice(0, 8) : fallback
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 700) : ''
}

function newIdeaId(): string {
  return `idea_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
