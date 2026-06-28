import type { PersistedMessage } from '../llm/persisted.js'
import { oneShotTextCompletion } from '../llm/oneShotCompletion.js'
import type { SubconsciousAgent } from '../subconscious/agent.js'
import type { StateDelta, SubconsciousStore } from '../subconscious/types.js'
import { saveSubconsciousStore } from '../subconscious/state.js'
import {
  analyzeAgentResponse,
  analyzeInput,
  applyUpdate,
  immediateDeltaFromAgentResponse,
} from '../subconscious/engine.js'
import { consolidateRecentMemory } from '../subconscious/memoryConsolidator.js'
import { SUBCONSCIOUS_DELTA_SYSTEM } from '../subconscious/prompts.js'
import { agentDebug } from '../utils/agentDebug.js'
import { executeMemoryAction as applyMemoryStore, type MemoryAction } from './structured.js'
import { executeProfileAction as applyProfileStore, type ProfileAction } from './userProfile.js'
import { executeKgAction as applyKgStore, type KgAction } from './knowledgeGraph.js'

const RECENT_LIMIT = 20

function parseDelta(raw: string): StateDelta | null {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  const parsed = JSON.parse(match[0]) as StateDelta
  if (!parsed || typeof parsed !== 'object') return null
  return parsed
}

export async function observeUserInput(agent: SubconsciousAgent, input: string): Promise<void> {
  await agent.start()
  if (!agent.store) return
  agent.idleHeartbeatCount = 0
  const analysis = analyzeInput(input)
  const delta = {}
  agent.store.recent = [
    ...agent.store.recent,
    { at: new Date().toISOString(), source: 'user' as const, text: input.slice(0, 500), analysis, delta },
  ].slice(-RECENT_LIMIT)
  await saveSubconsciousStore(agent.cwd, agent.store)
}

export async function observeAssistantOutput(agent: SubconsciousAgent, output: string): Promise<void> {
  await agent.start()
  if (!agent.store || !output.trim()) return
  const analysis = analyzeAgentResponse(output)
  const delta = immediateDeltaFromAgentResponse(analysis)
  agent.store.state = applyUpdate(agent.store.state, delta)
  agent.store.recent = [
    ...agent.store.recent,
    { at: new Date().toISOString(), source: 'assistant' as const, text: output.slice(0, 500), analysis, delta },
  ].slice(-RECENT_LIMIT)
  agent.applyRelationshipWindow()
  await saveSubconsciousStore(agent.cwd, agent.store)
  agent.render()
  agent.enqueueRefine(() => refineWithLlm(agent, output))
}

async function refineWithLlm(agent: SubconsciousAgent, input: string): Promise<void> {
  const profile = agent.config.llm.subconsciousProfile?.trim() || undefined
  if (!agent.store) return
  try {
    const raw = await oneShotTextCompletion({
      config: agent.config,
      profile,
      system: SUBCONSCIOUS_DELTA_SYSTEM,
      user: `当前状态：${JSON.stringify(agent.store.state)}\n\n主 Agent 回复：${input}`,
      maxOutTokens: 512,
    })
    const delta = parseDelta(raw)
    if (!delta || !agent.store) return
    agent.store.state = applyUpdate(agent.store.state, delta)
    await saveSubconsciousStore(agent.cwd, agent.store)
    agent.render()
  } catch (e) {
    agentDebug('[subconscious-agent] refine failed', e)
  }
}

export async function consolidateFromMessages(
  agent: SubconsciousAgent,
  messages: PersistedMessage[],
): Promise<void> {
  await agent.start()
  if (!agent.store) return
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
  agent.store.recent = [...agent.store.recent, ...additions].slice(-RECENT_LIMIT)
  agent.applyRelationshipWindow()
  // agentmem 模式：情景/长期记忆由 AgentMem 托管，跳过本地 documentMemory 巩固，仅保留情绪 recent 窗口。
  if (!agent.usesExternalMemory) {
    const beforeMemory = agent.currentDocumentMemoryFingerprint()
    agent.store = consolidateRecentMemory(agent.store)
    await saveSubconsciousStore(agent.cwd, agent.store)
    await agent.syncDocumentMemoryIfChanged(beforeMemory)
  } else {
    await saveSubconsciousStore(agent.cwd, agent.store)
  }
  agent.render()
}

export async function executeMemoryAction(
  agent: SubconsciousAgent,
  act: MemoryAction,
): Promise<Awaited<ReturnType<typeof applyMemoryStore>>> {
  return agent.enqueueMemoryWork(() => applyMemoryStore(agent.cwd, act))
}

export async function executeProfileAction(
  agent: SubconsciousAgent,
  act: ProfileAction,
): Promise<Awaited<ReturnType<typeof applyProfileStore>>> {
  return agent.enqueueMemoryWork(() => applyProfileStore(agent.cwd, act))
}

export async function executeKgAction(
  agent: SubconsciousAgent,
  act: KgAction,
): Promise<Awaited<ReturnType<typeof applyKgStore>>> {
  return agent.enqueueMemoryWork(() => applyKgStore(agent.cwd, act))
}
