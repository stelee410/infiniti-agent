import type { InfinitiConfig } from '../config/types.js'
import { loadMemoryStore } from '../memory/structured.js'
import { loadProfileStore } from '../memory/userProfile.js'
import * as memory from '../memory/index.js'

export async function buildSystemWithMemory(
  config: InfinitiConfig,
  cwd: string,
  memoryCoordinator?: {
    loadMemoryStore(): ReturnType<typeof loadMemoryStore>
    loadProfileStore(): ReturnType<typeof loadProfileStore>
    retrieveRelevantMemory?(query: string): Promise<string>
  },
  query?: string,
): Promise<string> {
  return memory.buildSystem(config, cwd, memoryCoordinator, query)
}
