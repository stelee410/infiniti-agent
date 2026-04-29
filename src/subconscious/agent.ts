import type { InfinitiConfig } from '../config/types.js'
import { oneShotTextCompletion } from '../llm/oneShotCompletion.js'
import type { PersistedMessage } from '../llm/persisted.js'
import { compactSessionMessages } from '../llm/compactSession.js'
import { executeMemoryAction, loadMemoryStore, type MemoryAction } from '../memory/structured.js'
import { executeProfileAction, loadProfileStore, type ProfileAction } from '../memory/userProfile.js'
import { executeKgAction, type KgAction } from '../memory/knowledgeGraph.js'
import { documentMemoryHitsToPromptBlock, retrieveDocumentMemories, syncDocumentMemory } from '../memory/documentMemory.js'
import { archiveSession } from '../session/archive.js'
import { searchSessions } from '../session/archive.js'
import { saveSession } from '../session/file.js'
import type { LiveUiSession } from '../liveui/wsSession.js'
import { agentDebug } from '../utils/agentDebug.js'
import {
  analyzeAgentResponse,
  analyzeInput,
  applyHeartbeatDecay,
  applyUpdate,
  immediateDeltaFromAgentResponse,
  planBehavior,
  relationshipDeltaFromDialogueWindow,
} from './engine.js'
import { consolidateRecentMemory } from './memoryConsolidator.js'
import { SUBCONSCIOUS_DELTA_SYSTEM } from './prompts.js'
import { loadSubconsciousStore, saveSubconsciousStore } from './state.js'
import type { StateDelta, SubconsciousStore } from './types.js'
import {
  DURABLE_CONSOLIDATION_SYSTEM,
  dominantTopic,
  hasSimilarMemory,
  hasSimilarProfile,
  historyResultsToTranscript,
  memoryCandidateInputs,
  messagesToTranscript,
  parseDurableConsolidation,
  recentToTranscript,
  shouldScanHistory,
  toKgAdd,
} from './consolidation.js'
import {
  addOrReinforceMemories,
  compressLongTermMemories,
  decayFuzzyMemories,
  longTermNeedsCompression,
} from './memoryLifecycle.js'

const RECENT_LIMIT = 20

function parseDelta(raw: string): StateDelta | null {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  const parsed = JSON.parse(match[0]) as StateDelta
  if (!parsed || typeof parsed !== 'object') return null
  return parsed
}

export class SubconsciousAgent {
  private store: SubconsciousStore | null = null
  private running = false
  private memoryQueue: Promise<unknown> = Promise.resolve()
  private refineQueue: Promise<unknown> = Promise.resolve()
  private compacting = false

  constructor(
    private readonly config: InfinitiConfig,
    private readonly cwd: string,
    private readonly liveUi?: LiveUiSession | null,
  ) {}

  async start(): Promise<void> {
    if (this.store) return
    this.store = await loadSubconsciousStore(this.cwd)
    await syncDocumentMemory(this.cwd, this.store).catch((e) => agentDebug('[subconscious-agent] document memory sync failed', e))
    this.render()
  }

  async observeUserInput(input: string): Promise<void> {
    await this.start()
    if (!this.store) return
    const analysis = analyzeInput(input)
    const delta = {}
    this.store.recent = [
      ...this.store.recent,
      { at: new Date().toISOString(), source: 'user' as const, text: input.slice(0, 500), analysis, delta },
    ].slice(-RECENT_LIMIT)
    await saveSubconsciousStore(this.cwd, this.store)
  }

  async observeAssistantOutput(output: string): Promise<void> {
    await this.start()
    if (!this.store || !output.trim()) return
    const analysis = analyzeAgentResponse(output)
    const delta = immediateDeltaFromAgentResponse(analysis)
    this.store.state = applyUpdate(this.store.state, delta)
    this.store.recent = [
      ...this.store.recent,
      { at: new Date().toISOString(), source: 'assistant' as const, text: output.slice(0, 500), analysis, delta },
    ].slice(-RECENT_LIMIT)
    this.applyRelationshipWindow()
    await saveSubconsciousStore(this.cwd, this.store)
    this.render()
    this.enqueueRefine(() => this.refineWithLlm(output))
  }

  async consolidateFromMessages(messages: PersistedMessage[]): Promise<void> {
    await this.start()
    if (!this.store) return
    const recent = messages.slice(-20)
    const additions: SubconsciousStore['recent'] = []
    for (const m of recent) {
      if (m.role === 'user') {
        const text = m.content.slice(0, 500)
        additions.push({ at: new Date().toISOString(), source: 'user', text, analysis: analyzeInput(text), delta: {} })
        continue
      }
      if (m.role === 'assistant' && m.content?.trim()) {
        const text = m.content.slice(0, 500)
        additions.push({ at: new Date().toISOString(), source: 'assistant', text, analysis: analyzeAgentResponse(text), delta: {} })
      }
    }
    if (additions.length === 0) return
    this.store.recent = [...this.store.recent, ...additions].slice(-RECENT_LIMIT)
    this.applyRelationshipWindow()
    this.store = consolidateRecentMemory(this.store)
    await saveSubconsciousStore(this.cwd, this.store)
    await syncDocumentMemory(this.cwd, this.store).catch((e) => agentDebug('[subconscious-agent] document memory sync failed', e))
    this.render()
  }

  async heartbeat(now = new Date()): Promise<void> {
    await this.start()
    if (!this.store || this.running) return
    this.running = true
    try {
      this.store.state = applyHeartbeatDecay(this.store.state, now.toISOString())
      this.applyRelationshipWindow()
      this.store = consolidateRecentMemory(this.store)
      this.store = decayFuzzyMemories(this.store, now)
      this.store = compressLongTermMemories(this.store, now)
      await saveSubconsciousStore(this.cwd, this.store)
      await syncDocumentMemory(this.cwd, this.store).catch((e) => agentDebug('[subconscious-agent] document memory sync failed', e))
      this.render()
      this.enqueueMemoryWork(() => this.scanHistoryForStableFacts(now)).catch((e) => {
        agentDebug('[subconscious-agent] history scan failed', e)
      })
    } finally {
      this.running = false
    }
  }

  async executeMemoryAction(act: MemoryAction): Promise<Awaited<ReturnType<typeof executeMemoryAction>>> {
    return this.enqueueMemoryWork(() => executeMemoryAction(this.cwd, act))
  }

  async executeProfileAction(act: ProfileAction): Promise<Awaited<ReturnType<typeof executeProfileAction>>> {
    return this.enqueueMemoryWork(() => executeProfileAction(this.cwd, act))
  }

  async executeKgAction(act: KgAction): Promise<Awaited<ReturnType<typeof executeKgAction>>> {
    return this.enqueueMemoryWork(() => executeKgAction(this.cwd, act))
  }

  async loadMemoryStore(): Promise<Awaited<ReturnType<typeof loadMemoryStore>>> {
    return loadMemoryStore(this.cwd)
  }

  async loadProfileStore(): Promise<Awaited<ReturnType<typeof loadProfileStore>>> {
    return loadProfileStore(this.cwd)
  }

  async retrieveRelevantMemory(query: string): Promise<string> {
    await this.start()
    const hits = await retrieveDocumentMemories(this.cwd, query, 6)
    void this.enqueueMemoryWork(() => this.reinforceRetrievedMemories(hits.map((hit) => hit.id))).catch((e) => {
      agentDebug('[subconscious-agent] memory reinforcement failed', e)
    })
    return documentMemoryHitsToPromptBlock(hits)
  }

  compactSessionAsync(opts: {
    messages: PersistedMessage[]
    minTailMessages: number
    maxToolSnippetChars: number
    customInstructions?: string
    preCompactHook?: string
  }): Promise<PersistedMessage[]> {
    return this.enqueueMemoryWork(async () => {
      this.compacting = true
      try {
        if (opts.messages.length > 0) {
          await archiveSession(this.cwd, opts.messages).catch(() => {})
        }
        const next = await compactSessionMessages({
          config: this.config,
          cwd: this.cwd,
          messages: opts.messages,
          minTailMessages: opts.minTailMessages,
          maxToolSnippetChars: opts.maxToolSnippetChars,
          customInstructions: opts.customInstructions,
          preCompactHook: opts.preCompactHook,
        })
        await saveSession(this.cwd, next)
        await this.consolidateFromMessages(next)
        await this.consolidateDurableMemory('compact-session', messagesToTranscript(opts.messages.slice(-80)))
        return next
      } finally {
        this.compacting = false
      }
    })
  }

  private async refineWithLlm(input: string): Promise<void> {
    const profile = this.config.llm.subconsciousProfile?.trim() || undefined
    if (!this.store) return
    try {
      const raw = await oneShotTextCompletion({
        config: this.config,
        profile,
        system: SUBCONSCIOUS_DELTA_SYSTEM,
        user: `当前状态：${JSON.stringify(this.store.state)}\n\n主 Agent 回复：${input}`,
        maxOutTokens: 512,
      })
      const delta = parseDelta(raw)
      if (!delta || !this.store) return
      this.store.state = applyUpdate(this.store.state, delta)
      await saveSubconsciousStore(this.cwd, this.store)
      this.render()
    } catch (e) {
      agentDebug('[subconscious-agent] refine failed', e)
    }
  }

  private async scanHistoryForStableFacts(now: Date): Promise<void> {
    await this.start()
    if (!this.store || !shouldScanHistory(this.store, now)) return

    const topic = dominantTopic(this.store)
    this.store.metadata.lastHistoryScanAt = now.toISOString()
    this.store.metadata.lastHistoryScanTopic = topic ?? undefined
    await saveSubconsciousStore(this.cwd, this.store)

    let transcript = recentToTranscript(this.store)
    if (topic) {
      const hits = await searchSessions(this.cwd, topic, 8).catch((e) => {
        agentDebug('[subconscious-agent] session search failed', e)
        return []
      })
      if (hits.length) {
        transcript = `${transcript}\n\n历史检索主题：${topic}\n\n${historyResultsToTranscript(hits)}`
      }
    }
    await this.consolidateDurableMemory(`heartbeat:${topic ?? 'recent-dialogue'}`, transcript)
  }

  private async consolidateDurableMemory(source: string, transcript: string): Promise<void> {
    await this.start()
    if (!this.store || !transcript.trim()) return
    const profile = this.config.llm.subconsciousProfile?.trim() || undefined
    try {
      const raw = await oneShotTextCompletion({
        config: this.config,
        profile,
        system: DURABLE_CONSOLIDATION_SYSTEM,
        user: `来源：${source}\n\n内容：\n${transcript}`,
        maxOutTokens: 1200,
      })
      const parsed = parseDurableConsolidation(raw)
      if (!parsed || !this.store) return

      const memoryStore = await loadMemoryStore(this.cwd)
      for (const item of (parsed.memories ?? []).slice(0, 5)) {
        if (!item.title?.trim() || !item.body?.trim()) continue
        if (hasSimilarMemory(memoryStore.entries, item)) continue
        const res = await executeMemoryAction(this.cwd, {
          action: 'add',
          title: item.title.slice(0, 80),
          body: item.body.slice(0, 500),
          tag: item.tag ?? 'other',
        })
        if (!res.ok) agentDebug('[subconscious-agent] memory consolidation skipped', res.error)
      }

      const profileStore = await loadProfileStore(this.cwd)
      for (const item of (parsed.profile ?? []).slice(0, 4)) {
        if (!item.title?.trim() || !item.body?.trim()) continue
        if (hasSimilarProfile(profileStore.entries, item)) continue
        const res = await executeProfileAction(this.cwd, {
          action: 'add',
          title: item.title.slice(0, 80),
          body: item.body.slice(0, 400),
          tag: item.tag ?? 'other',
        })
        if (!res.ok) agentDebug('[subconscious-agent] profile consolidation skipped', res.error)
      }

      for (const item of (parsed.knowledge ?? []).slice(0, 8)) {
        const act = toKgAdd(item, source)
        if (!act) continue
        const res = await executeKgAction(this.cwd, act)
        if (!res.ok) agentDebug('[subconscious-agent] knowledge consolidation skipped', res.error)
      }

      const now = new Date().toISOString()
      const topic = source.startsWith('heartbeat:') ? source.slice('heartbeat:'.length) : undefined
      const sourceType = source.startsWith('compact') ? 'compact' : source.startsWith('heartbeat') ? 'heartbeat' : 'history'
      this.store.memory.fuzzy = addOrReinforceMemories(this.store.memory.fuzzy, memoryCandidateInputs(parsed.fuzzy), {
        kind: 'fuzzy',
        source: { type: sourceType, ref: source, at: now },
        topic,
      }).items
      const longTermResult = addOrReinforceMemories(this.store.memory.longTerm, memoryCandidateInputs(parsed.longTerm), {
        kind: 'longTerm',
        source: { type: sourceType, ref: source, at: now },
        topic,
      })
      this.store.memory.longTerm = longTermResult.items
      if (longTermNeedsCompression(this.store)) {
        this.store = compressLongTermMemories(this.store, new Date(now))
      }
      this.store.metadata.lastDurableConsolidationAt = new Date().toISOString()
      await saveSubconsciousStore(this.cwd, this.store)
      await syncDocumentMemory(this.cwd, this.store).catch((e) => agentDebug('[subconscious-agent] document memory sync failed', e))
    } catch (e) {
      agentDebug('[subconscious-agent] durable consolidation failed', e)
    }
  }

  private async reinforceRetrievedMemories(ids: string[]): Promise<void> {
    if (!this.store || ids.length === 0) return
    const idSet = new Set(ids)
    const now = new Date().toISOString()
    for (const list of [this.store.memory.longTerm, this.store.memory.fuzzy]) {
      for (const item of list) {
        if (!idSet.has(item.id)) continue
        item.reinforcement += 1
        item.confidence = Math.min(1, item.confidence + 0.03)
        item.lastSeenAt = now
      }
    }
    this.store.metadata.lastRetrievedMemoryIds = ids
    await saveSubconsciousStore(this.cwd, this.store)
    await syncDocumentMemory(this.cwd, this.store).catch((e) => agentDebug('[subconscious-agent] document memory sync failed', e))
  }

  private enqueueMemoryWork<T>(work: () => Promise<T>): Promise<T> {
    const run = this.memoryQueue.then(work, work)
    this.memoryQueue = run.catch(() => {})
    return run
  }

  async waitForIdle(): Promise<void> {
    await this.memoryQueue.catch(() => {})
    await this.refineQueue.catch(() => {})
  }

  private enqueueRefine(work: () => Promise<void>): void {
    const run = this.refineQueue.then(work, work)
    this.refineQueue = run.catch(() => {})
  }

  private applyRelationshipWindow(): void {
    if (!this.store) return
    const analyses = this.store.recent
      .filter((r) => r.source === 'assistant')
      .slice(-20)
      .map((r) => r.analysis)
      .filter((a): a is ReturnType<typeof analyzeAgentResponse> => 'warmth' in a)
    const delta = relationshipDeltaFromDialogueWindow(analyses, this.store.state)
    this.store.state = applyUpdate(this.store.state, delta)
  }

  private render(): void {
    if (!this.liveUi || !this.store) return
    const command = planBehavior(this.store.state)
    this.liveUi.sendAction({
      expression: command.expression.name,
      intensity: command.expression.intensity,
      ...(command.gesture ? { motion: command.gesture } : {}),
    })
  }
}
