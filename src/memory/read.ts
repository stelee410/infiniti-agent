import type { InfinitiConfig } from '../config/types.js'
import { loadDreamPromptContext } from '../dreaming/dreamStore.js'
import { dreamPromptContextToPromptBlock } from '../dreaming/promptContext.js'
import { loadSkillsForCwd, skillsToSystemBlock } from '../skills/loader.js'
import { loadAgentPromptDocs, buildAgentSystemPrompt } from '../prompt/loadProjectPrompt.js'
import { MEMORY_NUDGE_SECTION } from '../prompt/memoryNudge.js'
import type { SubconsciousAgent } from '../subconscious/agent.js'
import { agentDebug } from '../utils/agentDebug.js'
import { documentMemoryHitsToPromptBlock, retrieveDocumentMemories } from './documentMemory.js'
import { loadMemoryStore, memoryToPromptBlock } from './structured.js'
import { loadProfileStore, profileToPromptBlock } from './userProfile.js'

function localIsoWithOffset(d: Date): string {
  const pad = (n: number): string => String(Math.trunc(Math.abs(n))).padStart(2, '0')
  const offsetMin = -d.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const hh = pad(offsetMin / 60)
  const mm = pad(offsetMin % 60)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${hh}:${mm}`
}

export async function buildSystem(
  _config: InfinitiConfig,
  cwd: string,
  memoryCoordinator?: {
    loadMemoryStore(): ReturnType<typeof loadMemoryStore>
    loadProfileStore(): ReturnType<typeof loadProfileStore>
    retrieveRelevantMemory?(query: string): Promise<string>
  },
  query?: string,
): Promise<string> {
  const [docs, memStore, profileStore, skills, retrievedMemory, dreamContext] = await Promise.all([
    loadAgentPromptDocs(cwd),
    memoryCoordinator?.loadMemoryStore() ?? loadMemoryStore(cwd),
    memoryCoordinator?.loadProfileStore() ?? loadProfileStore(cwd),
    loadSkillsForCwd(cwd),
    query?.trim()
      ? memoryCoordinator?.retrieveRelevantMemory
        ? memoryCoordinator.retrieveRelevantMemory(query)
        : retrieveDocumentMemories(cwd, query, 6).then(documentMemoryHitsToPromptBlock)
      : Promise.resolve(''),
    loadDreamPromptContext(cwd),
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

  const dreamBlock = dreamPromptContextToPromptBlock(dreamContext)
  if (dreamBlock.trim()) {
    parts.push(dreamBlock)
  }

  const skillBlock = skillsToSystemBlock(skills)
  if (skillBlock.trim()) {
    parts.push(skillBlock)
  }

  parts.push(MEMORY_NUDGE_SECTION)

  return parts.join('\n\n')
}

export async function buildCallSystem(
  config: InfinitiConfig,
  cwd: string,
  subconscious: SubconsciousAgent | undefined,
  augmentationBuffer: string[],
): Promise<string> {
  void config
  void subconscious
  const docs = await loadAgentPromptDocs(cwd)
  const personaBase = buildAgentSystemPrompt(docs)
  const memoryBlock = ''
  const augmentBlock = augmentationBuffer.length
    ? `\n\n## 后台补档（你上一轮回复之后异步整理出的相关信息）\n${augmentationBuffer.map((s, i) => `[${i + 1}] ${s}`).join('\n')}\n— 把这些事实自然地融到回复里，但不要主动说「我查了」。`
    : ''
  const callContract = [
    '',
    '## 当前模式：电话通话',
    '- 用户正在用语音跟你实时说话；你的回复会被 TTS 念出来。',
    '- 必须说人话、口语化，**不要 Markdown / 列表 / 代码块 / 表情标签**。',
    '- 一次回复尽量短（1～3 句话），抓重点，让对方有插话的机会。',
    '- 这一轮**没有**工具调用能力。后台另有一个补档进程在帮你查资料/回忆，但只能在下一轮用到结果。',
    '- 如果用户问的问题需要查工具才能精确回答（比如时间、行情、远程搜索），先口头给一个合理的近似答案或承诺，**不要**编造确切数字。',
  ].join('\n')
  return [personaBase, callContract, memoryBlock, augmentBlock].filter(Boolean).join('\n').trim()
}

export async function retrieveRelevantMemory(agent: SubconsciousAgent, query: string): Promise<string> {
  await agent.start()
  const hits = await retrieveDocumentMemories(agent.cwd, query, 6)
  void agent.enqueueMemoryWork(() => agent.reinforceRetrievedMemories(hits.map((hit) => hit.id))).catch((e) => {
    agentDebug('[subconscious-agent] memory reinforcement failed', e)
  })
  return documentMemoryHitsToPromptBlock(hits)
}
