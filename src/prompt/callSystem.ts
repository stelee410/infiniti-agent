import type { InfinitiConfig } from '../config/types.js'
import type { SubconsciousAgent } from '../subconscious/agent.js'
import * as memory from '../memory/index.js'

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
  return memory.buildCallSystem(config, cwd, subconscious, augmentationBuffer)
}
