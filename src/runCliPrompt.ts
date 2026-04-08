import { appendFile } from 'node:fs/promises'
import { ensureInfinitiDir } from './config/io.js'
import type { InfinitiConfig } from './config/types.js'
import { readMemoryForPrompt } from './memory/store.js'
import { McpManager } from './mcp/manager.js'
import { loadAgentPromptDocs, buildAgentSystemPrompt } from './prompt/loadProjectPrompt.js'
import { runToolLoop } from './llm/runLoop.js'
import type { PersistedMessage } from './llm/persisted.js'
import { loadSession, saveSession } from './session/file.js'
import { EditHistory } from './session/editHistory.js'
import { loadSkillsForConfig, skillsToSystemBlock } from './skills/loader.js'
import { ERROR_LOG_PATH } from './paths.js'
import { formatChatError } from './utils/formatError.js'

async function buildCliSystem(config: InfinitiConfig, cwd: string): Promise<string> {
  const mem = await readMemoryForPrompt()
  const skills = await loadSkillsForConfig(config)
  const docs = await loadAgentPromptDocs(cwd)
  const skillBlock = skillsToSystemBlock(skills)
  const parts = [buildAgentSystemPrompt(docs)]
  if (mem.trim()) {
    parts.push(`## 长期记忆（来自 ~/.infiniti-agent/memory.md）\n\n${mem}`)
  }
  if (skillBlock.trim()) {
    parts.push(skillBlock)
  }
  return parts.join('\n\n')
}

async function appendCliErrorLog(e: unknown): Promise<void> {
  await ensureInfinitiDir()
  const msg = formatChatError(e)
  const stack = e instanceof Error && e.stack ? `\n${e.stack}` : ''
  const line = `[${new Date().toISOString()}] --cli\n${msg}${stack}\n\n`
  await appendFile(ERROR_LOG_PATH, line, 'utf8')
}

/**
 * 非交互执行一轮：自动批准工具、流式输出到 stdout、持久化会话；失败时写入 error.log 并 exit(1)。
 */
export async function runCliPrompt(
  config: InfinitiConfig,
  prompt: string,
): Promise<never> {
  const mcp = new McpManager()
  const editHistory = new EditHistory()

  let exitCode = 0
  let cwd = process.cwd()
  let messages: PersistedMessage[] = []

  try {
    await mcp.start(config)

    try {
      const s = await loadSession()
      if (s?.messages?.length) {
        messages = s.messages
        cwd = s.cwd || cwd
      }
    } catch (e: unknown) {
      throw e
    }

    const nextMsgs: PersistedMessage[] = [
      ...messages,
      { role: 'user', content: prompt },
    ]

    const system = await buildCliSystem(config, cwd)
    const { messages: out } = await runToolLoop({
      config,
      system,
      messages: nextMsgs,
      cwd,
      mcp,
      confirmTool: async () => true,
      editHistory,
      stream: {
        onStreamReset: () => {
          process.stdout.write('\n')
        },
        onTextDelta: (delta) => {
          process.stdout.write(delta)
        },
        onThinkingDelta: () => {
          // CLI 模式下静默忽略 thinking 增量（避免干扰 stdout 管道输出）
        },
      },
    })
    await saveSession(cwd, out)
    process.stdout.write('\n')
  } catch (e: unknown) {
    await appendCliErrorLog(e).catch(() => {
      /* 日志写入失败时仍尽量退出 */
    })
    console.error(
      `执行失败：${formatChatError(e)}（完整信息已写入 ${ERROR_LOG_PATH}）`,
    )
    exitCode = 1
  } finally {
    await mcp.stop().catch(() => {
      /* ignore */
    })
  }

  process.exit(exitCode)
}
