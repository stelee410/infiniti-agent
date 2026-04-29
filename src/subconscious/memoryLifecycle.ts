import type { SubconsciousMemoryEntry, SubconsciousMemorySource, SubconsciousStore } from './types.js'

const LONG_TERM_MAX_ITEMS = 32
const FUZZY_MAX_ITEMS = 28
const LONG_TERM_COMPRESS_THRESHOLD = 40
const FUZZY_DECAY_INTERVAL_MS = 6 * 60 * 60 * 1000

export type MemoryLifecycleResult = {
  items: SubconsciousMemoryEntry[]
  created: SubconsciousMemoryEntry[]
}

export type MemoryLifecycleInput = string | { text: string; confidence?: number }

export function addOrReinforceMemories(
  existing: SubconsciousMemoryEntry[],
  texts: MemoryLifecycleInput[] | undefined,
  opts: {
    kind: 'fuzzy' | 'longTerm'
    source: SubconsciousMemorySource
    topic?: string
    maxItems?: number
  },
): MemoryLifecycleResult {
  const items = existing.map((item) => ({ ...item, sources: [...item.sources] }))
  const created: SubconsciousMemoryEntry[] = []
  for (const raw of texts ?? []) {
    const text = cleanText(typeof raw === 'string' ? raw : raw.text)
    if (!text) continue
    const inputConfidence = typeof raw === 'string' ? undefined : raw.confidence
    const found = items.find((item) => similar(item.text, text))
    if (found) {
      found.reinforcement += 1
      found.confidence = clamp(Math.max(found.confidence, inputConfidence ?? 0) + (opts.kind === 'longTerm' ? 0.08 : 0.06))
      found.lastSeenAt = opts.source.at
      found.topic = found.topic ?? opts.topic
      found.sources = appendSource(found.sources, opts.source)
      continue
    }
    const entry: SubconsciousMemoryEntry = {
      id: generateId(opts.kind),
      text,
      confidence: clamp(inputConfidence ?? (opts.kind === 'longTerm' ? 0.72 : 0.46)),
      reinforcement: 1,
      sources: [opts.source],
      firstSeenAt: opts.source.at,
      lastSeenAt: opts.source.at,
      validFrom: opts.source.at,
      topic: opts.topic,
    }
    items.push(entry)
    created.push(entry)
  }
  return {
    items: rankAndLimit(items, opts.maxItems ?? (opts.kind === 'longTerm' ? LONG_TERM_MAX_ITEMS : FUZZY_MAX_ITEMS)),
    created,
  }
}

export function decayFuzzyMemories(store: SubconsciousStore, now = new Date()): SubconsciousStore {
  const last = store.metadata.lastFuzzyDecayAt ? Date.parse(store.metadata.lastFuzzyDecayAt) : 0
  if (Number.isFinite(last) && now.getTime() - last < FUZZY_DECAY_INTERVAL_MS) return store
  const items = store.memory.fuzzy
    .map((item) => {
      const daysSinceSeen = Math.max(0, (now.getTime() - Date.parse(item.lastSeenAt)) / 86_400_000)
      const reinforcementBuffer = Math.min(0.08, item.reinforcement * 0.01)
      const decay = Math.min(0.16, 0.025 + daysSinceSeen * 0.01)
      return {
        ...item,
        confidence: clamp(item.confidence - decay + reinforcementBuffer),
      }
    })
    .filter((item) => item.confidence >= 0.22 || item.reinforcement >= 3)
  return {
    ...store,
    metadata: { ...store.metadata, lastFuzzyDecayAt: now.toISOString() },
    memory: {
      ...store.memory,
      fuzzy: rankAndLimit(items, FUZZY_MAX_ITEMS),
    },
  }
}

export function compressLongTermMemories(store: SubconsciousStore, now = new Date()): SubconsciousStore {
  if (store.memory.longTerm.length <= LONG_TERM_MAX_ITEMS && store.memory.longTerm.length < LONG_TERM_COMPRESS_THRESHOLD) {
    return store
  }
  const merged: SubconsciousMemoryEntry[] = []
  for (const item of store.memory.longTerm) {
    const found = merged.find((m) => similar(m.text, item.text))
    if (!found) {
      merged.push({ ...item, sources: [...item.sources] })
      continue
    }
    found.text = found.text.length <= item.text.length ? found.text : item.text
    found.confidence = clamp(Math.max(found.confidence, item.confidence) + 0.04)
    found.reinforcement += item.reinforcement
    found.lastSeenAt = later(found.lastSeenAt, item.lastSeenAt)
    found.sources = [...found.sources, ...item.sources].slice(-8)
    found.topic = found.topic ?? item.topic
  }
  return {
    ...store,
    metadata: { ...store.metadata, lastLongTermCompressionAt: now.toISOString() },
    memory: {
      ...store.memory,
      longTerm: rankAndLimit(merged, LONG_TERM_MAX_ITEMS),
    },
  }
}

export function longTermNeedsCompression(store: SubconsciousStore): boolean {
  return store.memory.longTerm.length > LONG_TERM_MAX_ITEMS || store.memory.longTerm.length >= LONG_TERM_COMPRESS_THRESHOLD
}

function rankAndLimit(items: SubconsciousMemoryEntry[], limit: number): SubconsciousMemoryEntry[] {
  return [...items]
    .sort((a, b) => score(b) - score(a))
    .slice(0, limit)
    .sort((a, b) => Date.parse(a.firstSeenAt) - Date.parse(b.firstSeenAt))
}

function score(item: SubconsciousMemoryEntry): number {
  const recency = Math.max(0, Date.parse(item.lastSeenAt) / 1_000_000_000_000)
  return item.confidence * 10 + Math.log1p(item.reinforcement) + recency
}

function appendSource(sources: SubconsciousMemorySource[], source: SubconsciousMemorySource): SubconsciousMemorySource[] {
  const key = `${source.type}:${source.ref ?? ''}`
  const filtered = sources.filter((s) => `${s.type}:${s.ref ?? ''}` !== key)
  return [...filtered, source].slice(-8)
}

function similar(a: string, b: string): boolean {
  const ak = normalize(a)
  const bk = normalize(b)
  if (!ak || !bk) return false
  if (ak === bk || ak.includes(bk) || bk.includes(ak)) return true
  const aset = new Set(ak.split(' '))
  const bset = new Set(bk.split(' '))
  const intersection = [...aset].filter((t) => bset.has(t)).length
  const union = new Set([...aset, ...bset]).size || 1
  return intersection / union >= 0.72
}

function cleanText(input: string): string {
  return input.trim().replace(/\s+/g, ' ').slice(0, 280)
}

function normalize(input: string): string {
  return input.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, ' ').trim()
}

function later(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b
}

function generateId(kind: 'fuzzy' | 'longTerm'): string {
  return `sm_${kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}
