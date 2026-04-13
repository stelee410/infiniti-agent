import type { InfinitiConfig } from '../config/types.js'
import { loadMemoryStore, memoryToPromptBlock } from '../memory/structured.js'
import { loadProfileStore, profileToPromptBlock } from '../memory/userProfile.js'
import { loadSkillsForCwd, skillsToSystemBlock } from '../skills/loader.js'
import { loadAgentPromptDocs, buildAgentSystemPrompt } from './loadProjectPrompt.js'
import { MEMORY_NUDGE_SECTION } from './memoryNudge.js'

export async function buildSystemWithMemory(
  _config: InfinitiConfig,
  cwd: string,
): Promise<string> {
  const [docs, memStore, profileStore, skills] = await Promise.all([
    loadAgentPromptDocs(cwd),
    loadMemoryStore(cwd),
    loadProfileStore(cwd),
    loadSkillsForCwd(cwd),
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

  const skillBlock = skillsToSystemBlock(skills)
  if (skillBlock.trim()) {
    parts.push(skillBlock)
  }

  parts.push(MEMORY_NUDGE_SECTION)

  return parts.join('\n\n')
}
