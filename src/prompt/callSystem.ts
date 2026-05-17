import type { InfinitiConfig } from '../config/types.js'
import { loadAgentPromptDocs, buildAgentSystemPrompt } from './loadProjectPrompt.js'
import type { SubconsciousAgent } from '../subconscious/agent.js'

/**
 * 通话模式专用 system prompt：
 *  - 保留人格 / 项目背景
 *  - 去掉表情标签 / TTS 控制 / 工具说明（call 模式不传 tools）
 *  - 显式要求口语化、短句、不要 markdown
 *  - 注入「augmenter 备档」段落，让本轮回复能用到上一轮后台异步检索的结果
 */
export async function buildCallSystem(
  config: InfinitiConfig,
  cwd: string,
  subconscious: SubconsciousAgent | undefined,
  augmentationBuffer: string[],
): Promise<string> {
  void config // 预留：未来按 config 微调 prompt
  const docs = await loadAgentPromptDocs(cwd)
  const personaBase = buildAgentSystemPrompt(docs)
  const memoryBlock = ''  // 通话模式不预先拉 memory，留给 augmenter 按需补
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
