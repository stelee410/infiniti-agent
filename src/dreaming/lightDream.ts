import type { InfinitiConfig } from '../config/types.js'
import { oneShotTextCompletion } from '../llm/oneShotCompletion.js'
import type { DreamEpisode, DreamSource } from './types.js'
import { LIGHT_DREAM_SYSTEM } from './prompts.js'
import { parseJsonObject } from './json.js'

type LightDreamJson = {
  summary?: string
  topics?: string[]
  keyFacts?: string[]
  userPreferences?: string[]
  projectSignals?: string[]
  emotionalSignals?: string[]
  unresolvedQuestions?: string[]
}

export async function runLightDream(opts: {
  config: InfinitiConfig
  profile?: string
  source: DreamSource
  recentTranscript: string
  historyTranscript?: string
  rawEventRefs?: string[]
  now?: Date
}): Promise<DreamEpisode> {
  const now = opts.now ?? new Date()
  const fallback = fallbackEpisode({
    source: opts.source,
    recentTranscript: opts.recentTranscript,
    historyTranscript: opts.historyTranscript ?? '',
    rawEventRefs: opts.rawEventRefs ?? [],
    now,
  })
  if (!opts.recentTranscript.trim() && !opts.historyTranscript?.trim()) return fallback
  try {
    const raw = await oneShotTextCompletion({
      config: opts.config,
      profile: opts.profile,
      system: LIGHT_DREAM_SYSTEM,
      user: [
        '最近对话：',
        opts.recentTranscript || '(empty)',
        '',
        '相关历史：',
        opts.historyTranscript || '(empty)',
      ].join('\n'),
      maxOutTokens: 900,
      temperature: 0.2,
      topP: 0.8,
    })
    const parsed = parseJsonObject<LightDreamJson>(raw)
    if (!parsed) return fallback
    return {
      ...fallback,
      summary: clean(parsed.summary) || fallback.summary,
      topics: cleanList(parsed.topics, fallback.topics),
      keyFacts: cleanList(parsed.keyFacts, fallback.keyFacts),
      userPreferences: cleanList(parsed.userPreferences, fallback.userPreferences),
      projectSignals: cleanList(parsed.projectSignals, fallback.projectSignals),
      emotionalSignals: cleanList(parsed.emotionalSignals, fallback.emotionalSignals),
      unresolvedQuestions: cleanList(parsed.unresolvedQuestions, fallback.unresolvedQuestions),
    }
  } catch {
    return fallback
  }
}

function fallbackEpisode(opts: {
  source: DreamSource
  recentTranscript: string
  historyTranscript: string
  rawEventRefs: string[]
  now: Date
}): DreamEpisode {
  const combined = [opts.recentTranscript, opts.historyTranscript].filter(Boolean).join('\n\n')
  const lines = combined.split('\n').map((line) => line.trim()).filter(Boolean)
  const topics = topicTokens(combined).slice(0, 8)
  const preferenceLines = lines.filter((line) => /记住|以后|偏好|喜欢|不喜欢|不要|别再|prefer|preference/i.test(line))
  const projectLines = lines.filter((line) => /项目|代码|模块|架构|系统|runtime|agent|memory|dream|prompt|repo|spec/i.test(line))
  const emotionalLines = lines.filter((line) => /累|开心|焦虑|烦|喜欢|信任|关系|tension|happy|sad|angry/i.test(line))
  return {
    id: `episode_${opts.now.toISOString().replace(/[:.]/g, '-')}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: opts.now.toISOString(),
    source: opts.source,
    summary: summarize(lines),
    topics,
    keyFacts: projectLines.slice(0, 4).map(stripRole),
    userPreferences: preferenceLines.slice(0, 4).map(stripRole),
    projectSignals: projectLines.slice(0, 6).map(stripRole),
    emotionalSignals: emotionalLines.slice(0, 4).map(stripRole),
    unresolvedQuestions: lines.filter((line) => /[?？]|怎么|如何|是否|what|how/i.test(line)).slice(0, 4).map(stripRole),
    rawEventRefs: opts.rawEventRefs,
  }
}

function summarize(lines: string[]): string {
  if (!lines.length) return '没有足够的新对话可整理。'
  return lines.slice(-6).map(stripRole).join(' / ').slice(0, 480)
}

function topicTokens(text: string): string[] {
  const stop = new Set(['user', 'assistant', 'the', 'and', 'for', 'with', '这个', '那个', '我们', '需要', '可以'])
  const seen = new Set<string>()
  const out: string[] = []
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_-]{2,}|[\p{Script=Han}]{2,8}/gu)) {
    const token = match[0].slice(0, 24)
    const key = token.toLowerCase()
    if (stop.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push(token)
  }
  return out
}

function stripRole(line: string): string {
  return line.replace(/^(user|assistant|用户|Agent|助手)\s*[:：]\s*/i, '').trim().slice(0, 240)
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 800) : ''
}

function cleanList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  const out = value.map(clean).filter(Boolean)
  return out.length ? out.slice(0, 12) : fallback
}
