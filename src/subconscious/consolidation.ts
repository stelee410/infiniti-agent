import type { MemoryEntry, MemoryTag } from '../memory/structured.js'
import type { ProfileEntry, ProfileTag } from '../memory/userProfile.js'
import type { KgAction } from '../memory/knowledgeGraph.js'
import type { SearchResult } from '../session/archive.js'
import type { PersistedMessage } from '../llm/persisted.js'
import type { SubconsciousStore } from './types.js'

export type DurableMemoryCandidate = {
  title: string
  body: string
  tag?: MemoryTag
}

export type DurableProfileCandidate = {
  title: string
  body: string
  tag?: ProfileTag
}

export type DurableKgCandidate = {
  subject: string
  predicate: string
  object: string
}

export type DurableConsolidation = {
  memories?: DurableMemoryCandidate[]
  profile?: DurableProfileCandidate[]
  knowledge?: DurableKgCandidate[]
  fuzzy?: Array<string | { text: string; confidence?: number; source?: string }>
  longTerm?: Array<string | { text: string; confidence?: number; source?: string }>
}

export const DURABLE_CONSOLIDATION_SYSTEM = `你是 subconscious-agent 的记忆整理器。
从给定对话/摘要中抽取稳定事实，只输出 JSON。
规则：
- 只保留后续对话可能复用的稳定事实、用户长期偏好、项目约定、角色/关系状态。
- 不要保存一次性寒暄、临时步骤、低置信度猜测、用户未确认的推断。
- knowledge 只放明确实体关系三元组，predicate 用短语。
- memories 用于项目/任务/环境/约定，profile 用于用户画像/沟通偏好/工作流。
- fuzzy 和 longTerm 是 Agent 潜意识用的软记忆，必须附带 confidence，0.4 表示弱信号，0.8 表示稳定确认。
返回格式：
{
  "memories":[{"title":"...","body":"...","tag":"fact|preference|lesson|convention|environment|other"}],
  "profile":[{"title":"...","body":"...","tag":"tech_stack|communication|workflow|background|other"}],
  "knowledge":[{"subject":"...","predicate":"...","object":"..."}],
  "fuzzy":[{"text":"...","confidence":0.45,"source":"..."}],
  "longTerm":[{"text":"...","confidence":0.75,"source":"..."}]
}`

const HISTORY_SCAN_MIN_RECENT = 8
const HISTORY_SCAN_WINDOW_MS = 10 * 60 * 1000
const HISTORY_SCAN_COOLDOWN_MS = 15 * 60 * 1000
const MAX_TRANSCRIPT_CHARS = 12000

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'have',
  'what',
  '怎么',
  '这个',
  '那个',
  '现在',
  '一下',
  '功能',
  '实现',
  '需要',
  '应该',
  '进行',
])

export function parseDurableConsolidation(raw: string): DurableConsolidation | null {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  const parsed = JSON.parse(match[0]) as DurableConsolidation
  if (!parsed || typeof parsed !== 'object') return null
  return parsed
}

export function messagesToTranscript(messages: PersistedMessage[], limit = MAX_TRANSCRIPT_CHARS): string {
  const chunks: string[] = []
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const text = m.content?.trim()
    if (!text) continue
    chunks.push(`${m.role}: ${text}`)
  }
  return chunks.join('\n\n').slice(-limit)
}

export function historyResultsToTranscript(results: SearchResult[], limit = MAX_TRANSCRIPT_CHARS): string {
  return results
    .map((r) => `[session ${r.sessionId} ${r.sessionDate} ${r.role}] ${r.sessionSummary}\n${r.snippet}`)
    .join('\n\n')
    .slice(0, limit)
}

export function recentToTranscript(store: SubconsciousStore, limit = MAX_TRANSCRIPT_CHARS): string {
  return store.recent
    .map((r) => `${r.source}: ${r.text}`)
    .join('\n\n')
    .slice(-limit)
}

export function shouldScanHistory(store: SubconsciousStore, now = new Date()): boolean {
  const last = store.metadata.lastHistoryScanAt ? Date.parse(store.metadata.lastHistoryScanAt) : 0
  if (Number.isFinite(last) && now.getTime() - last < HISTORY_SCAN_COOLDOWN_MS) return false
  const recent = store.recent.filter((r) => now.getTime() - Date.parse(r.at) <= HISTORY_SCAN_WINDOW_MS)
  if (recent.length >= HISTORY_SCAN_MIN_RECENT) return true
  const topic = dominantTopic(store)
  if (!topic) return false
  const hits = store.recent.filter((r) => normalize(r.text).includes(normalize(topic))).length
  return hits >= 4
}

export function dominantTopic(store: SubconsciousStore): string | null {
  const counts = new Map<string, number>()
  for (const r of store.recent.slice(-20)) {
    for (const token of topicTokens(r.text)) {
      counts.set(token, (counts.get(token) ?? 0) + (r.source === 'user' ? 2 : 1))
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])
  return ranked[0]?.[1] >= 3 ? ranked[0][0] : null
}

export function appendUnique(list: string[], items: string[] | undefined, maxItems: number): string[] {
  const next = [...list]
  const seen = new Set(next.map(normalize))
  for (const item of items ?? []) {
    const clean = item.trim()
    if (!clean) continue
    const key = normalize(clean)
    if (seen.has(key)) continue
    seen.add(key)
    next.push(clean.slice(0, 240))
  }
  return next.slice(-maxItems)
}

export function memoryCandidateTexts(items: DurableConsolidation['fuzzy'] | DurableConsolidation['longTerm']): string[] {
  return (items ?? [])
    .map((item) => typeof item === 'string' ? item : item.text)
    .filter((text): text is string => typeof text === 'string' && Boolean(text.trim()))
}

export function memoryCandidateInputs(
  items: DurableConsolidation['fuzzy'] | DurableConsolidation['longTerm'],
): Array<string | { text: string; confidence?: number }> {
  return (items ?? [])
    .map((item): string | { text: string; confidence?: number } => {
      if (typeof item === 'string') return item
      return typeof item.confidence === 'number' ? { text: item.text, confidence: item.confidence } : { text: item.text }
    })
    .filter((item): item is string | { text: string; confidence?: number } =>
      typeof item === 'string' ? Boolean(item.trim()) : Boolean(item.text?.trim())
    )
}

export function hasSimilarMemory(entries: MemoryEntry[], item: DurableMemoryCandidate): boolean {
  return hasSimilarEntry(entries, item.title, item.body)
}

export function hasSimilarProfile(entries: ProfileEntry[], item: DurableProfileCandidate): boolean {
  return hasSimilarEntry(entries, item.title, item.body)
}

export function toKgAdd(item: DurableKgCandidate, source: string): KgAction | null {
  const subject = item.subject?.trim()
  const predicate = item.predicate?.trim()
  const object = item.object?.trim()
  if (!subject || !predicate || !object) return null
  return { action: 'add', subject: subject.slice(0, 120), predicate: predicate.slice(0, 80), object: object.slice(0, 180), source }
}

function topicTokens(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_-]{2,}|[\p{Script=Han}]{2,8}/gu)) {
    const raw = m[0]
    const token = raw.length > 8 ? raw.slice(0, 8) : raw
    const key = normalize(token)
    if (STOP_WORDS.has(key)) continue
    out.push(token)
  }
  return out
}

function hasSimilarEntry(entries: Array<{ title: string; body: string }>, title: string, body: string): boolean {
  const key = normalize(`${title} ${body}`)
  if (!key) return true
  return entries.some((e) => {
    const existing = normalize(`${e.title} ${e.body}`)
    return existing === key || existing.includes(key) || key.includes(existing)
  })
}

function normalize(input: string): string {
  return input.toLowerCase().replace(/\s+/g, ' ').trim()
}
