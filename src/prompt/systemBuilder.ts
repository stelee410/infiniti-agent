import type { InfinitiConfig } from '../config/types.js'
import { documentMemoryHitsToPromptBlock, retrieveDocumentMemories } from '../memory/documentMemory.js'
import { loadMemoryStore, memoryToPromptBlock } from '../memory/structured.js'
import { loadProfileStore, profileToPromptBlock } from '../memory/userProfile.js'
import { loadSkillsForCwd, skillsToSystemBlock } from '../skills/loader.js'
import { loadAgentPromptDocs, buildAgentSystemPrompt } from './loadProjectPrompt.js'
import { MEMORY_NUDGE_SECTION } from './memoryNudge.js'

export async function buildSystemWithMemory(
  _config: InfinitiConfig,
  cwd: string,
  memoryCoordinator?: {
    loadMemoryStore(): ReturnType<typeof loadMemoryStore>
    loadProfileStore(): ReturnType<typeof loadProfileStore>
    retrieveRelevantMemory?(query: string): Promise<string>
  },
  query?: string,
): Promise<string> {
  const [docs, memStore, profileStore, skills, retrievedMemory] = await Promise.all([
    loadAgentPromptDocs(cwd),
    memoryCoordinator?.loadMemoryStore() ?? loadMemoryStore(cwd),
    memoryCoordinator?.loadProfileStore() ?? loadProfileStore(cwd),
    loadSkillsForCwd(cwd),
    query?.trim()
      ? memoryCoordinator?.retrieveRelevantMemory
        ? memoryCoordinator.retrieveRelevantMemory(query)
        : retrieveDocumentMemories(cwd, query, 6).then(documentMemoryHitsToPromptBlock)
      : Promise.resolve(''),
  ])

  const parts = [buildAgentSystemPrompt(docs)]

  const memBlock = memoryToPromptBlock(memStore)
  if (memBlock) {
    parts.push(memBlock)
  }

  const profileBlock = profileToPromptBlock(profileStore)
  if (profileBlock) {
    parts.push(profileBlock)
  }

  if (retrievedMemory.trim()) {
    parts.push(retrievedMemory)
  }

  const skillBlock = skillsToSystemBlock(skills)
  if (skillBlock.trim()) {
    parts.push(skillBlock)
  }

  parts.push(MEMORY_NUDGE_SECTION)

  return parts.join('\n\n')
}
