import type { SubconsciousStore } from './types.js'
import { addOrReinforceMemories, compressLongTermMemories } from './memoryLifecycle.js'

const MAX_ITEMS = 20

function pushUnique(items: string[], value: string): string[] {
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (!normalized || items.includes(normalized)) return items
  return [...items, normalized].slice(-MAX_ITEMS)
}

export function consolidateRecentMemory(store: SubconsciousStore): SubconsciousStore {
  const next: SubconsciousStore = {
    ...store,
    memory: {
      project: [...store.memory.project],
      userPreference: [...store.memory.userPreference],
      persona: [...store.memory.persona],
      fuzzy: store.memory.fuzzy.map((item) => ({ ...item, sources: [...item.sources] })),
      longTerm: store.memory.longTerm.map((item) => ({ ...item, sources: [...item.sources] })),
    },
  }
  const now = new Date().toISOString()
  for (const item of store.recent.slice(-5)) {
    const input = item.text.trim()
    if (!input) continue
    if (/记住|以后|偏好|我喜欢|我不喜欢|不要|别再|prefer|preference/i.test(input)) {
      next.memory.userPreference = pushUnique(next.memory.userPreference, input.slice(0, 220))
    } else if (/项目|代码|模块|架构|约定|配置|repo|module|config/i.test(input)) {
      next.memory.project = pushUnique(next.memory.project, input.slice(0, 220))
    } else if (/关系|陪|信任|情绪|人格|语气|relationship|trust|mood/i.test(input)) {
      next.memory.persona = pushUnique(next.memory.persona, input.slice(0, 220))
    } else if (
      ('intimacySignal' in item.analysis && item.analysis.intimacySignal > 0.25) ||
      ('correctionSignal' in item.analysis && item.analysis.correctionSignal > 0.4)
    ) {
      next.memory.fuzzy = addOrReinforceMemories(next.memory.fuzzy, [input.slice(0, 220)], {
        kind: 'fuzzy',
        source: { type: 'recent', ref: item.source, at: now },
      }).items
    }
  }
  const stable = [
    ...next.memory.project.slice(-5),
    ...next.memory.userPreference.slice(-5),
    ...next.memory.persona.slice(-5),
  ]
  next.memory.longTerm = addOrReinforceMemories(next.memory.longTerm, stable, {
    kind: 'longTerm',
    source: { type: 'recent', ref: 'heuristic-stable', at: now },
  }).items
  return compressLongTermMemories(next)
}
