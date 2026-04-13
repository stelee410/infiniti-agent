import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { localAgentDir } from '../paths.js'

export type SkillUsageRecord = {
  skillId: string
  usedAt: string
  toolCallCount: number
}

export type SkillUsageStore = {
  version: 1
  records: SkillUsageRecord[]
}

const TRACKER_FILE = 'skill_usage.json'
const MAX_RECORDS = 200

function trackerPath(cwd: string): string {
  return join(localAgentDir(cwd), TRACKER_FILE)
}

export async function loadUsageStore(cwd: string): Promise<SkillUsageStore> {
  const p = trackerPath(cwd)
  try {
    const raw = await readFile(p, 'utf8')
    const parsed = JSON.parse(raw) as SkillUsageStore
    if (parsed?.version === 1 && Array.isArray(parsed.records)) {
      return parsed
    }
  } catch {
    // file doesn't exist or invalid
  }
  return { version: 1, records: [] }
}

async function saveUsageStore(cwd: string, store: SkillUsageStore): Promise<void> {
  const p = trackerPath(cwd)
  await mkdir(dirname(p), { recursive: true })
  if (store.records.length > MAX_RECORDS) {
    store.records = store.records.slice(-MAX_RECORDS)
  }
  await writeFile(p, JSON.stringify(store, null, 2) + '\n', 'utf8')
}

export async function recordSkillUsage(
  cwd: string,
  skillId: string,
  toolCallCount: number,
): Promise<void> {
  const store = await loadUsageStore(cwd)
  store.records.push({
    skillId,
    usedAt: new Date().toISOString(),
    toolCallCount,
  })
  await saveUsageStore(cwd, store)
}

export async function getSkillUsageSummary(
  cwd: string,
  skillId: string,
): Promise<{ totalUses: number; lastUsed: string | null }> {
  const store = await loadUsageStore(cwd)
  const relevant = store.records.filter((r) => r.skillId === skillId)
  return {
    totalUses: relevant.length,
    lastUsed: relevant.length > 0 ? relevant[relevant.length - 1]!.usedAt : null,
  }
}
