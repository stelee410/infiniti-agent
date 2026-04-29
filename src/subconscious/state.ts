import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { localAgentDir } from '../paths.js'
import type { MetaState, SubconsciousMemoryEntry, SubconsciousStore } from './types.js'

const FILE = 'subconscious.json'

export function subconsciousPath(cwd: string): string {
  return join(localAgentDir(cwd), FILE)
}

export function defaultMetaState(now = new Date().toISOString()): MetaState {
  return {
    emotion: 'neutral',
    emotionIntensity: 0.2,
    mood: 0,
    affinity: 0,
    trust: 0,
    intimacy: 0,
    respect: 0,
    tension: 0,
    confidence: 0.6,
    engagement: 0.5,
    speechStyle: 'natural',
    updatedAt: now,
  }
}

export function defaultSubconsciousStore(): SubconsciousStore {
  return {
    version: 1,
    metadata: {},
    state: defaultMetaState(),
    memory: {
      project: [],
      userPreference: [],
      persona: [],
      fuzzy: [],
      longTerm: [],
    },
    recent: [],
  }
}

export async function loadSubconsciousStore(cwd: string): Promise<SubconsciousStore> {
  try {
    const raw = await readFile(subconsciousPath(cwd), 'utf8')
    const parsed = JSON.parse(raw) as SubconsciousStore
    if (parsed?.version === 1 && parsed.state && Array.isArray(parsed.recent)) {
      const fallback = defaultSubconsciousStore()
      return {
        ...parsed,
        metadata: {
          ...fallback.metadata,
          ...(parsed.metadata && typeof parsed.metadata === 'object' ? parsed.metadata : {}),
        },
        memory: {
          ...fallback.memory,
          ...(parsed.memory && typeof parsed.memory === 'object' ? parsed.memory : {}),
          fuzzy: migrateMemoryEntries((parsed.memory as { fuzzy?: unknown } | undefined)?.fuzzy, 'fuzzy'),
          longTerm: migrateMemoryEntries((parsed.memory as { longTerm?: unknown } | undefined)?.longTerm, 'longTerm'),
        },
      }
    }
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    if (err.code !== 'ENOENT') throw e
  }
  return defaultSubconsciousStore()
}

function migrateMemoryEntries(value: unknown, ref: string): SubconsciousMemoryEntry[] {
  if (!Array.isArray(value)) return []
  const now = new Date().toISOString()
  return value
    .map((item, idx): SubconsciousMemoryEntry | null => {
      if (typeof item === 'string') {
        const text = item.trim()
        if (!text) return null
        return {
          id: `sm_${Date.now().toString(36)}_${ref}_${idx}`,
          text,
          confidence: ref === 'longTerm' ? 0.7 : 0.45,
          reinforcement: 1,
          sources: [{ type: 'manual', ref: 'migration', at: now }],
          firstSeenAt: now,
          lastSeenAt: now,
        }
      }
      if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
        const raw = item as Partial<SubconsciousMemoryEntry>
        const text = raw.text?.trim()
        if (!text) return null
        return {
          id: raw.id || `sm_${Date.now().toString(36)}_${ref}_${idx}`,
          text,
          confidence: clamp(typeof raw.confidence === 'number' ? raw.confidence : ref === 'longTerm' ? 0.7 : 0.45),
          reinforcement: Math.max(1, Math.floor(raw.reinforcement ?? 1)),
          sources: Array.isArray(raw.sources) ? raw.sources : [{ type: 'manual', ref: 'migration', at: now }],
          firstSeenAt: raw.firstSeenAt || now,
          lastSeenAt: raw.lastSeenAt || now,
          validFrom: raw.validFrom,
          validUntil: raw.validUntil,
          topic: raw.topic,
        }
      }
      return null
    })
    .filter((item): item is SubconsciousMemoryEntry => Boolean(item))
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

export async function saveSubconsciousStore(cwd: string, store: SubconsciousStore): Promise<void> {
  const p = subconsciousPath(cwd)
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, JSON.stringify(store, null, 2) + '\n', 'utf8')
}
