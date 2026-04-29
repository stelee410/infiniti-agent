import type { InfinitiConfig } from '../config/types.js'
import { documentMemoryHitsToPromptBlock, retrieveDocumentMemories } from '../memory/documentMemory.js'
import { loadMemoryStore, memoryToPromptBlock } from '../memory/structured.js'
import { loadProfileStore, profileToPromptBlock } from '../memory/userProfile.js'
import { loadSkillsForCwd, skillsToSystemBlock } from '../skills/loader.js'
import { loadAgentPromptDocs, buildAgentSystemPrompt } from './loadProjectPrompt.js'
import { MEMORY_NUDGE_SECTION } from './memoryNudge.js'

function localIsoWithOffset(d: Date): string {
  const pad = (n: number): string => String(Math.trunc(Math.abs(n))).padStart(2, '0')
  const offsetMin = -d.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const hh = pad(offsetMin / 60)
  const mm = pad(offsetMin % 60)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${hh}:${mm}`
}

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
  const now = new Date()
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
  parts.push([
    '## 当前时间',
    `- 当前本地时间：${now.toLocaleString('zh-CN', { hour12: false })}`,
    `- 当前本地 ISO 时间：${localIsoWithOffset(now)}`,
    `- 当前 ISO 时间：${now.toISOString()}`,
    `- 当前时区：${timezone}`,
    '- 当用户表达提醒、定时、稍后、每天、每隔一段时间、remind/notify/schedule/later/every day 等计划任务意图时，调用 `schedule` 工具创建/查询/删除任务；不要说你无法定时。',
    '- 创建计划任务时，把用户自然语言时间换算为 `schedule` 工具需要的结构化字段；任务正文 `prompt` 应去掉时间短语，保留到点后真正要执行的内容。',
  ].join('\n'))

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
