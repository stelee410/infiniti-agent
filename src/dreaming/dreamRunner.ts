import type { InfinitiConfig } from '../config/types.js'
import { syncDocumentMemory } from '../memory/documentMemory.js'
import { executeMemoryAction, loadMemoryStore, type MemoryTag } from '../memory/structured.js'
import { writeInboxMessage } from '../inbox/store.js'
import { searchSessions } from '../session/archive.js'
import {
  dominantTopic,
  historyResultsToTranscript,
  recentToTranscript,
} from '../subconscious/consolidation.js'
import { addOrReinforceMemories } from '../subconscious/memoryLifecycle.js'
import { applyUpdate } from '../subconscious/engine.js'
import { loadSubconsciousStore, saveSubconsciousStore } from '../subconscious/state.js'
import type { SubconsciousStore } from '../subconscious/types.js'
import { runDeepDream } from './deepDream.js'
import {
  appendDreamEpisode,
  appendDreamMemoryCandidates,
  finishDreamRun,
  loadRecentDreamDiaries,
  saveDreamDiary,
  saveDreamPromptContext,
  startDreamRun,
} from './dreamStore.js'
import { runLightDream } from './lightDream.js'
import { runRemDream } from './remDream.js'
import type { DeepDreamResult, DreamMode, DreamRun, DreamSource } from './types.js'

export const DEFAULT_DREAM_INTERVAL_MS = 4 * 60 * 60 * 1000
const MIN_RECENT_ITEMS_FOR_FULL_DREAM = 4

export type RunDreamResult = {
  run: DreamRun
  deep?: DeepDreamResult
}

export function shouldRunDream(
  store: SubconsciousStore,
  now = new Date(),
  intervalMs = DEFAULT_DREAM_INTERVAL_MS,
): boolean {
  if (store.recent.length === 0) return false
  const lastDreamAt = store.metadata.lastDreamAt ? Date.parse(store.metadata.lastDreamAt) : 0
  if (!Number.isFinite(lastDreamAt) || lastDreamAt <= 0) return true
  return now.getTime() - lastDreamAt >= intervalMs
}

export function chooseDreamMode(store: SubconsciousStore): DreamMode {
  return store.recent.length >= MIN_RECENT_ITEMS_FOR_FULL_DREAM ? 'full' : 'light'
}

export async function runDream(opts: {
  config: InfinitiConfig
  cwd: string
  mode?: DreamMode
  source: DreamSource
  reason: string
  now?: Date
  writeInbox?: boolean
}): Promise<RunDreamResult> {
  const now = opts.now ?? new Date()
  let run = await startDreamRun(opts.cwd, {
    mode: opts.mode ?? 'full',
    source: opts.source,
    reason: opts.reason,
    now,
  })
  try {
    let store = await loadSubconsciousStore(opts.cwd)
    if (store.recent.length === 0) {
      run = await finishDreamRun(opts.cwd, run, { status: 'skipped' }, now)
      return { run }
    }

    const mode = opts.mode ?? chooseDreamMode(store)
    run = { ...run, mode }
    const recentTranscript = recentToTranscript(store)
    const historyTranscript = await loadHistoryTranscript(opts.cwd, store)
    const profile = opts.config.llm.subconsciousProfile?.trim() || undefined
    const episode = await runLightDream({
      config: opts.config,
      profile,
      source: opts.source,
      recentTranscript,
      historyTranscript,
      rawEventRefs: store.recent.map((r) => `${r.source}:${r.at}`),
      now,
    })
    await appendDreamEpisode(opts.cwd, episode)

    if (mode === 'light') {
      const deep = runDeepDream({
        episode,
        rem: {
          repeatedPatterns: episode.topics,
          projectUnderstanding: episode.projectSignals,
          relationshipSignals: [],
          emotionalTrend: episode.emotionalSignals,
          unresolvedThreads: episode.unresolvedQuestions,
          memoryCandidates: [],
          selfReflection: episode.summary,
          behaviorGuidance: ['根据最近梦境保持回答聚焦、清晰、保守。'],
        },
        now,
      })
      await saveDreamDiary(opts.cwd, deep.dreamDiary)
      await saveDreamPromptContext(opts.cwd, deep.promptContext)
      store.metadata.lastDreamAt = now.toISOString()
      store.metadata.lastDreamRunId = run.id
      delete store.metadata.lastDreamError
      await saveSubconsciousStore(opts.cwd, store)
      run = await finishDreamRun(opts.cwd, run, { status: 'completed', episodeId: episode.id, diaryId: deep.dreamDiary.id }, now)
      return { run, deep }
    }

    const rem = await runRemDream({
      config: opts.config,
      profile,
      episode,
      existingLongTermMemories: store.memory.longTerm.map((m) => m.text),
      existingFuzzyMemories: store.memory.fuzzy.map((m) => m.text),
      metaState: store.state,
      recentDreams: await loadRecentDreamDiaries(opts.cwd, 3),
      now,
    })
    await appendDreamMemoryCandidates(opts.cwd, rem.memoryCandidates, {
      runId: run.id,
      episodeId: episode.id,
      createdAt: now.toISOString(),
    })
    const deep = runDeepDream({ episode, rem, now })
    applyExistingObjectiveFallback(deep, store, now)
    store = await applyDeepDream(opts.cwd, store, deep, now)
    await saveDreamDiary(opts.cwd, deep.dreamDiary)
    await saveDreamPromptContext(opts.cwd, deep.promptContext)
    if (opts.writeInbox && deep.dreamDiary.messageToUser) {
      await writeInboxMessage(opts.cwd, {
        subject: 'Jess 的梦里想到一件事',
        body: deep.dreamDiary.messageToUser,
        meta: { source: 'dream-runtime', dreamRunId: run.id },
      }).catch(() => undefined)
    }
    store.metadata.lastDreamAt = now.toISOString()
    store.metadata.lastDreamRunId = run.id
    delete store.metadata.lastDreamError
    await saveSubconsciousStore(opts.cwd, store)
    await syncDocumentMemory(opts.cwd, store).catch(() => undefined)
    run = await finishDreamRun(opts.cwd, run, { status: 'completed', episodeId: episode.id, diaryId: deep.dreamDiary.id }, now)
    return { run, deep }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const store = await loadSubconsciousStore(opts.cwd).catch(() => null)
    if (store) {
      store.metadata.lastDreamError = message
      await saveSubconsciousStore(opts.cwd, store).catch(() => undefined)
    }
    run = await finishDreamRun(opts.cwd, run, { status: 'failed', error: message }, now)
    return { run }
  }
}

async function applyDeepDream(
  cwd: string,
  store: SubconsciousStore,
  deep: DeepDreamResult,
  now: Date,
): Promise<SubconsciousStore> {
  const source = { type: 'heartbeat' as const, ref: 'dream-runtime', at: now.toISOString() }
  await persistStructuredDreamMemories(cwd, deep.memoriesCreated)
  const longTerm = addOrReinforceMemories(store.memory.longTerm, deep.memoriesCreated, {
    kind: 'longTerm',
    source,
    topic: 'dream-runtime',
  })
  const fuzzy = addOrReinforceMemories(store.memory.fuzzy, deep.fuzzyMemoriesCreated, {
    kind: 'fuzzy',
    source,
    topic: 'dream-runtime',
  })
  const next: SubconsciousStore = {
    ...store,
    state: applyUpdate(store.state, deep.metaStatePatch, now.toISOString()),
    memory: {
      ...store.memory,
      longTerm: longTerm.items,
      fuzzy: fuzzy.items,
    },
  }
  return applyObjectiveToState(next, deep, now)
}

function applyExistingObjectiveFallback(deep: DeepDreamResult, store: SubconsciousStore, now: Date): void {
  if (deep.longHorizonObjective) return
  const current = store.state.longHorizonObjective
  if (!current) return
  if (Date.parse(current.expiresAt) <= now.getTime()) return
  deep.longHorizonObjective = current
  deep.promptContext.longHorizonObjective = current.objective
  deep.dreamDiary.currentObjective = current.objective
}

function applyObjectiveToState(store: SubconsciousStore, deep: DeepDreamResult, now: Date): SubconsciousStore {
  if (!deep.longHorizonObjective || deep.longHorizonObjective.confidence < 0.6) return store
  if (Date.parse(deep.longHorizonObjective.expiresAt) <= now.getTime()) return store
  return {
    ...store,
    state: {
      ...store.state,
      longHorizonObjective: deep.longHorizonObjective,
    },
  }
}

async function persistStructuredDreamMemories(cwd: string, memories: string[]): Promise<void> {
  if (memories.length === 0) return
  const store = await loadMemoryStore(cwd)
  const existing = new Set(store.entries.map((entry) => normalize(`${entry.title} ${entry.body}`)))
  for (const memory of memories.slice(0, 5)) {
    const body = memory.trim().slice(0, 500)
    if (!body) continue
    const key = normalize(body)
    if ([...existing].some((item) => item.includes(key) || key.includes(item))) continue
    const tag = memoryTagFor(body)
    const title = body.slice(0, 60)
    const res = await executeMemoryAction(cwd, {
      action: 'add',
      title,
      body,
      tag,
    })
    if (res.ok) existing.add(normalize(`${title} ${body}`))
  }
}

function memoryTagFor(memory: string): MemoryTag {
  if (/偏好|喜欢|不喜欢|希望|prefer|preference/i.test(memory)) return 'preference'
  if (/约定|规则|不要|必须|convention/i.test(memory)) return 'convention'
  if (/环境|本地|单机|repo|目录|workspace|environment/i.test(memory)) return 'environment'
  if (/学到|经验|lesson/i.test(memory)) return 'lesson'
  return 'fact'
}

function normalize(input: string): string {
  return input.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, ' ').trim()
}

async function loadHistoryTranscript(cwd: string, store: SubconsciousStore): Promise<string> {
  const topic = dominantTopic(store)
  if (!topic) return ''
  const hits = await searchSessions(cwd, topic, 6).catch(() => [])
  return hits.length ? historyResultsToTranscript(hits) : ''
}
