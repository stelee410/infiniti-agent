import type { InfinitiConfig } from '../config/types.js'
import { oneShotTextCompletion } from '../llm/oneShotCompletion.js'
import type { PersistedMessage } from '../llm/persisted.js'
import { compactSessionMessages } from '../llm/compactSession.js'
import { executeMemoryAction, loadMemoryStore, type MemoryAction } from '../memory/structured.js'
import { executeProfileAction, loadProfileStore, type ProfileAction } from '../memory/userProfile.js'
import { executeKgAction, type KgAction } from '../memory/knowledgeGraph.js'
import { syncDocumentMemory } from '../memory/documentMemory.js'
import * as memory from '../memory/index.js'
import { chooseDreamMode, runDream, shouldRunDream, type RunDreamResult } from '../dreaming/dreamRunner.js'
import type { DreamMode, DreamSource } from '../dreaming/types.js'
import { archiveSession } from '../session/archive.js'
import { searchSessions } from '../session/archive.js'
import { saveSession } from '../session/file.js'
import type { LiveUiSession } from '../liveui/wsSession.js'
import type { ExternalMemoryBackend } from '../memory/external/agentmem.js'
import { agentDebug } from '../utils/agentDebug.js'
import {
  analyzeAgentResponse,
  applyHeartbeatDecay,
  applyUpdate,
  planBehavior,
  relationshipDeltaFromDialogueWindow,
} from './engine.js'
import { consolidateRecentMemory } from './memoryConsolidator.js'
import { loadSubconsciousStore, saveSubconsciousStore } from './state.js'
import type { MetaState, SubconsciousStore } from './types.js'
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

const PROACTIVE_IDLE_HEARTBEATS = 10
const PROACTIVE_MIN_INTERVAL_MS = 30 * 60 * 1000

function documentMemoryFingerprint(store: SubconsciousStore): string {
  return JSON.stringify({
    fuzzy: store.memory.fuzzy.map((m) => ({
      id: m.id,
      text: m.text,
      confidence: m.confidence,
      reinforcement: m.reinforcement,
      lastSeenAt: m.lastSeenAt,
      validFrom: m.validFrom,
      validUntil: m.validUntil,
      topic: m.topic,
      sources: m.sources,
    })),
    longTerm: store.memory.longTerm.map((m) => ({
      id: m.id,
      text: m.text,
      confidence: m.confidence,
      reinforcement: m.reinforcement,
      lastSeenAt: m.lastSeenAt,
      validFrom: m.validFrom,
      validUntil: m.validUntil,
      topic: m.topic,
      sources: m.sources,
    })),
  })
}

export class SubconsciousAgent {
  /** memory module 直接读写 store。 */
  store: SubconsciousStore | null = null
  private running = false
  private memoryQueue: Promise<unknown> = Promise.resolve()
  private refineQueue: Promise<unknown> = Promise.resolve()
  private compacting = false
  private documentMemoryFingerprint: string | null = null
  private debugOverlayEnabled = false
  /** memory module 在 observeUserInput 时清零。 */
  idleHeartbeatCount = 0
  private lastProactiveGreetingAt = 0
  private dreaming = false
  /** Replace 模式下暂存上一条用户输入，用于配对每轮原文上送外部记忆。 */
  private lastUserInput = ''
  /** 外部记忆每轮 Idempotency-Key 的自增轮次。 */
  private externalTurnCounter = 0

  constructor(
    readonly config: InfinitiConfig,
    readonly cwd: string,
    private readonly liveUi?: LiveUiSession | null,
    /** 配置了 AgentMem 时注入；存在即 Replace 模式（检索/写入走外部，短路本地提炼）。 */
    private readonly externalMemory?: ExternalMemoryBackend,
  ) {}

  async start(): Promise<void> {
    if (this.store) return
    this.store = await loadSubconsciousStore(this.cwd)
    await this.syncDocumentMemoryIfChanged()
    this.render()
  }

  async setDebugOverlayEnabled(enabled: boolean): Promise<void> {
    this.debugOverlayEnabled = enabled
    await this.start()
    this.sendDebugState(enabled)
  }

  getDebugSnapshot(): LiveUiDebugSnapshot | null {
    if (!this.store) return null
    return debugSnapshotFromMetaState(this.store.state)
  }

  isDreaming(): boolean {
    return this.dreaming
  }

  /** agentmem 模式：AgentMem 接管情景/长期记忆，本地仍跑情绪引擎与常驻记忆层。 */
  get usesExternalMemory(): boolean {
    return !!this.externalMemory
  }

  async observeUserInput(input: string): Promise<void> {
    // 情绪引擎始终在本地运行；agentmem 模式下额外暂存用户输入用于配对上送。
    if (this.externalMemory) this.lastUserInput = input
    return memory.observeUserInput(this, input)
  }

  async observeAssistantOutput(output: string): Promise<void> {
    // agentmem 模式：把这一轮原文上送外部记忆（情绪引擎仍照常在本地跑）。
    if (this.externalMemory && output.trim()) {
      const user = this.lastUserInput
      this.lastUserInput = ''
      const idemKey = this.makeExternalIdempotencyKey()
      const backend = this.externalMemory
      void this.enqueueMemoryWork(() => backend.add(user, output, idemKey)).catch((e) => {
        agentDebug('[agentmem] add enqueue failed', e)
      })
    }
    return memory.observeAssistantOutput(this, output)
  }

  /** session 标识 + 自增轮次，幂等防重放（不使用时间戳）。 */
  private makeExternalIdempotencyKey(): string {
    this.externalTurnCounter += 1
    return `${this.externalSessionTag()}_turn_${this.externalTurnCounter}`
  }

  private externalSessionTag(): string {
    let hash = 0
    for (let i = 0; i < this.cwd.length; i++) {
      hash = (hash * 31 + this.cwd.charCodeAt(i)) | 0
    }
    return `sess_${(hash >>> 0).toString(36)}`
  }

  async consolidateFromMessages(messages: PersistedMessage[]): Promise<void> {
    // agentmem 模式下，write.ts 内部会跳过本地 documentMemory 巩固，仅保留情绪 recent 窗口。
    return memory.consolidateFromMessages(this, messages)
  }

  async heartbeat(
    now = new Date(),
    opts: { allowProactiveGreeting?: boolean } = {},
  ): Promise<string | null> {
    await this.start()
    if (!this.store || this.running) return null
    this.running = true
    const started = Date.now()
    let proactiveGreeting: string | null = null
    // agentmem 模式：保留情绪衰减 / render / 主动打招呼 / dream，跳过本地 documentMemory 巩固。
    const localMemory = !this.usesExternalMemory
    try {
      const beforeMemory = this.currentDocumentMemoryFingerprint()
      this.store.state = applyHeartbeatDecay(this.store.state, now.toISOString())
      this.applyRelationshipWindow()
      if (localMemory) {
        this.store = consolidateRecentMemory(this.store)
        this.store = decayFuzzyMemories(this.store, now)
        this.store = compressLongTermMemories(this.store, now)
      }
      this.store.metadata.lastHeartbeatAt = now.toISOString()
      this.store.metadata.lastHeartbeatDurationMs = Date.now() - started
      await saveSubconsciousStore(this.cwd, this.store)
      if (localMemory) await this.syncDocumentMemoryIfChanged(beforeMemory)
      this.idleHeartbeatCount += 1
      this.render({ heartbeatMicroAction: true })
      proactiveGreeting = await this.maybeCreateProactiveGreeting(now, opts.allowProactiveGreeting === true)
      if (localMemory) {
        this.enqueueMemoryWork(() => this.scanHistoryForStableFacts(now)).catch((e) => {
          agentDebug('[subconscious-agent] history scan failed', e)
        })
      }
      if (shouldRunDream(this.store, now)) {
        const mode = chooseDreamMode(this.store)
        this.enqueueMemoryWork(async () => {
          await this.runDreamDirect({ mode, source: 'heartbeat', reason: 'periodic heartbeat dream', now })
        }).catch((e) => {
          agentDebug('[subconscious-agent] dream runtime failed', e)
        })
      }
    } finally {
      if (this.store) {
        this.store.metadata.lastHeartbeatDurationMs = Date.now() - started
        await saveSubconsciousStore(this.cwd, this.store).catch((e) => agentDebug('[subconscious-agent] heartbeat metadata save failed', e))
      }
      this.running = false
    }
    return proactiveGreeting
  }

  // structured 记忆 / 用户画像 / 知识图谱属于「常驻小层」，agentmem 模式下仍保留在本地、每轮全量注入。
  async executeMemoryAction(act: MemoryAction): Promise<Awaited<ReturnType<typeof executeMemoryAction>>> {
    return memory.executeMemoryAction(this, act)
  }

  async executeProfileAction(act: ProfileAction): Promise<Awaited<ReturnType<typeof executeProfileAction>>> {
    return memory.executeProfileAction(this, act)
  }

  async executeKgAction(act: KgAction): Promise<Awaited<ReturnType<typeof executeKgAction>>> {
    return memory.executeKgAction(this, act)
  }

  async loadMemoryStore(): Promise<Awaited<ReturnType<typeof loadMemoryStore>>> {
    return loadMemoryStore(this.cwd)
  }

  async loadProfileStore(): Promise<Awaited<ReturnType<typeof loadProfileStore>>> {
    return loadProfileStore(this.cwd)
  }

  async retrieveRelevantMemory(query: string): Promise<string> {
    if (this.externalMemory) {
      const ctx = await this.externalMemory.query(query)
      return ctx ? `## 相关长期记忆（来自 AgentMem）\n${ctx}` : ''
    }
    return memory.retrieveRelevantMemory(this, query)
  }

  async runDreamNow(opts: {
    mode?: DreamMode
    source?: DreamSource
    reason?: string
    now?: Date
    writeInbox?: boolean
  } = {}): Promise<RunDreamResult> {
    return this.enqueueMemoryWork(() => this.runDreamDirect(opts))
  }

  private async runDreamDirect(opts: {
    mode?: DreamMode
    source?: DreamSource
    reason?: string
    now?: Date
    writeInbox?: boolean
  }): Promise<RunDreamResult> {
    this.dreaming = true
    this.renderDreamingPose()
    try {
      const result = await runDream({
        config: this.config,
        cwd: this.cwd,
        mode: opts.mode,
        source: opts.source ?? 'manual',
        reason: opts.reason ?? 'manual dream run',
        now: opts.now,
        writeInbox: opts.writeInbox,
      })
      this.store = await loadSubconsciousStore(this.cwd)
      await this.syncDocumentMemoryIfChanged()
      return result
    } finally {
      this.dreaming = false
      this.render()
      this.renderAwakePose()
    }
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
      const startedAt = Date.now()
      agentDebug('[subconscious-agent] compact start', {
        messages: opts.messages.length,
        minTailMessages: opts.minTailMessages,
        maxToolSnippetChars: opts.maxToolSnippetChars,
        customInstructions: Boolean(opts.customInstructions?.trim()),
        preCompactHook: Boolean(opts.preCompactHook),
      })
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
        agentDebug('[subconscious-agent] compact complete', {
          beforeMessages: opts.messages.length,
          afterMessages: next.length,
          durationMs: Date.now() - startedAt,
        })
        return next
      } catch (e) {
        agentDebug('[subconscious-agent] compact failed', e)
        throw e
      } finally {
        this.compacting = false
      }
    })
  }

  private async scanHistoryForStableFacts(now: Date): Promise<void> {
    await this.start()
    if (!this.store || !shouldScanHistory(this.store, now)) return

    const topic = dominantTopic(this.store)
    this.store.metadata.lastHistoryScanAt = now.toISOString()
    this.store.metadata.lastHistoryScanTopic = topic ?? undefined
    this.store.metadata.historyScanRunning = true
    delete this.store.metadata.lastHistoryScanError
    await saveSubconsciousStore(this.cwd, this.store)

    try {
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
    } catch (e) {
      if (this.store) {
        this.store.metadata.lastHistoryScanError = e instanceof Error ? e.message : String(e)
      }
      throw e
    } finally {
      if (this.store) {
        this.store.metadata.historyScanRunning = false
        await saveSubconsciousStore(this.cwd, this.store).catch((e) => agentDebug('[subconscious-agent] history metadata save failed', e))
      }
    }
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
      await this.syncDocumentMemoryIfChanged()
    } catch (e) {
      agentDebug('[subconscious-agent] durable consolidation failed', e)
    }
  }

  async reinforceRetrievedMemories(ids: string[]): Promise<void> {
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
    await this.syncDocumentMemoryIfChanged()
  }

  currentDocumentMemoryFingerprint(): string | null {
    return this.store ? documentMemoryFingerprint(this.store) : null
  }

  async syncDocumentMemoryIfChanged(previous?: string | null): Promise<void> {
    if (!this.store) return
    const next = documentMemoryFingerprint(this.store)
    const before = previous ?? this.documentMemoryFingerprint
    if (before === next && this.store.metadata.lastDocumentMemorySyncAt) return
    try {
      await syncDocumentMemory(this.cwd, this.store)
      this.documentMemoryFingerprint = next
      this.store.metadata.lastDocumentMemorySyncAt = new Date().toISOString()
      await saveSubconsciousStore(this.cwd, this.store)
    } catch (e) {
      agentDebug('[subconscious-agent] document memory sync failed', e)
    }
  }

  enqueueMemoryWork<T>(work: () => Promise<T>): Promise<T> {
    const run = this.memoryQueue.then(work, work)
    this.memoryQueue = run.catch(() => {})
    return run
  }

  async waitForIdle(): Promise<void> {
    await this.memoryQueue.catch(() => {})
    await this.refineQueue.catch(() => {})
  }

  enqueueRefine(work: () => Promise<void>): void {
    const run = this.refineQueue.then(work, work)
    this.refineQueue = run.catch(() => {})
  }

  applyRelationshipWindow(): void {
    if (!this.store) return
    const analyses = this.store.recent
      .filter((r) => r.source === 'assistant')
      .slice(-20)
      .map((r) => r.analysis)
      .filter((a): a is ReturnType<typeof analyzeAgentResponse> => 'warmth' in a)
    const delta = relationshipDeltaFromDialogueWindow(analyses, this.store.state)
    this.store.state = applyUpdate(this.store.state, delta)
  }

  render(opts: { heartbeatMicroAction?: boolean } = {}): void {
    if (!this.liveUi || !this.store) return
    const command = planBehavior(this.store.state)
    const microAction = opts.heartbeatMicroAction ? this.heartbeatMicroAction() : {}
    this.liveUi.sendAction({
      expression: command.expression.name,
      intensity: command.expression.intensity,
      ...(command.gesture ? { motion: command.gesture } : {}),
      ...microAction,
    })
    if (this.debugOverlayEnabled) {
      this.sendDebugState(true)
    }
  }

  private renderDreamingPose(): void {
    if (!this.liveUi) return
    this.liveUi.sendStatusPill('做梦中…', 'loading')
    this.liveUi.sendAction({
      expression: 'neutral',
      intensity: 0.25,
      gaze: 'close',
      motion: 'idle',
    })
  }

  private renderAwakePose(): void {
    if (!this.liveUi) return
    this.liveUi.sendStatusPill('就绪', 'ready')
    this.liveUi.sendAction({ gaze: 'center' })
  }

  private sendDebugState(enabled: boolean): void {
    if (!this.liveUi) return
    if (!enabled || !this.store) {
      this.liveUi.sendDebugState({ enabled: false })
      return
    }
    this.liveUi.sendDebugState({ enabled: true, ...debugSnapshotFromMetaState(this.store.state) })
  }

  private heartbeatMicroAction(): { motion?: string; gaze?: string } {
    const r = Math.random()
    if (r < 0.55) {
      const gaze = ['left', 'right', 'up', 'down', 'center'][Math.floor(Math.random() * 5)]
      return { gaze }
    }
    if (r < 0.8) {
      return { motion: Math.random() < 0.5 ? 'shake' : 'nod' }
    }
    return {}
  }

  private async maybeCreateProactiveGreeting(now: Date, allowed: boolean): Promise<string | null> {
    if (!allowed || !this.liveUi || !this.store) return null
    if (this.idleHeartbeatCount <= PROACTIVE_IDLE_HEARTBEATS) return null
    if (now.getTime() - this.lastProactiveGreetingAt < PROACTIVE_MIN_INTERVAL_MS) return null
    const recent = this.store.recent
      .slice(-8)
      .map((r) => `${r.source === 'user' ? '用户' : 'Agent'}: ${r.text}`)
      .join('\n')
    const s = this.store.state
    const profile = this.config.llm.subconsciousProfile?.trim() || undefined
    try {
      const text = await oneShotTextCompletion({
        config: this.config,
        profile,
        maxOutTokens: 512,
        system:
          '你是 subconscious-agent 的主动陪伴模块。只在用户长时间没有互动时，为主 Agent 生成一句非常短的中文招呼。要求：自然、克制、不打扰；不要解释原因；不要提 heartbeat；可以带一个 LiveUI 表情标签，如 [Happy] 或 [Thinking]；最多 35 个中文字符。',
        user:
          `当前关系指数：trust=${s.trust.toFixed(2)}, affinity=${s.affinity.toFixed(2)}, intimacy=${s.intimacy.toFixed(2)}, respect=${s.respect.toFixed(2)}, tension=${s.tension.toFixed(2)}。\n` +
          `当前情绪：${s.emotion} ${s.emotionIntensity.toFixed(2)}。\n` +
          `最近对话：\n${recent || '暂无'}\n\n请生成一句主动招呼。`,
      })
      const greeting = text.replace(/\s+/g, ' ').trim()
      if (!greeting) return null
      this.idleHeartbeatCount = 0
      this.lastProactiveGreetingAt = now.getTime()
      await this.observeAssistantOutput(greeting)
      return greeting
    } catch (e) {
      agentDebug('[subconscious-agent] proactive greeting skipped', e)
      return null
    }
  }
}

type LiveUiDebugSnapshot = {
  emotion: string
  emotionIntensity: number
  relationship: {
    trust: number
    affinity: number
    intimacy: number
    respect: number
    tension: number
  }
}

function debugSnapshotFromMetaState(state: MetaState): LiveUiDebugSnapshot {
  return {
    emotion: state.emotion,
    emotionIntensity: state.emotionIntensity,
    relationship: {
      trust: state.trust,
      affinity: state.affinity,
      intimacy: state.intimacy,
      respect: state.respect,
      tension: state.tension,
    },
  }
}
