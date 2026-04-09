import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ensureLocalAgentDir } from './config/io.js'
import type { InfinitiConfig } from './config/types.js'
import { readMemoryForPrompt } from './memory/store.js'
import { McpManager } from './mcp/manager.js'
import { loadAgentPromptDocs, buildAgentSystemPrompt } from './prompt/loadProjectPrompt.js'
import { runToolLoop } from './llm/runLoop.js'
import type { PersistedMessage } from './llm/persisted.js'
import { loadSession, saveSession } from './session/file.js'
import { EditHistory } from './session/editHistory.js'
import { loadSkillsForCwd, skillsToSystemBlock } from './skills/loader.js'
import { localErrorLogPath } from './paths.js'
import { formatChatError } from './utils/formatError.js'

async function buildCliSystem(config: InfinitiConfig, cwd: string): Promise<string> {
  const mem = await readMemoryForPrompt(cwd)
  const skills = await loadSkillsForCwd(cwd)
  const docs = await loadAgentPromptDocs(cwd)
  const skillBlock = skillsToSystemBlock(skills)
  const parts = [buildAgentSystemPrompt(docs)]
  if (mem.trim()) {
    parts.push(`## 长期记忆（来自 .infiniti-agent/memory.md）\n\n${mem}`)
  }
  if (skillBlock.trim()) {
    parts.push(skillBlock)
  }
  return parts.join('\n\n')
}

async function appendCliErrorLog(cwd: string, e: unknown): Promise<void> {
  await ensureLocalAgentDir(cwd)
  const logPath = localErrorLogPath(cwd)
  await mkdir(dirname(logPath), { recursive: true })
  const msg = formatChatError(e)
  const stack = e instanceof Error && e.stack ? `\n${e.stack}` : ''
  const line = `[${new Date().toISOString()}] cli\n${msg}${stack}\n\n`
  await appendFile(logPath, line, 'utf8')
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
  const cwd = process.cwd()
  let messages: PersistedMessage[] = []

  try {
    await mcp.start(config)

    try {
      const s = await loadSession(cwd)
      if (s?.messages?.length) {
        messages = s.messages
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
      editHistory,
      stream: {
        onStreamReset: () => {
          process.stdout.write('\n')
        },
        onTextDelta: (delta) => {
          process.stdout.write(delta)
        },
        onThinkingDelta: () => {},
      },
    })
    await saveSession(cwd, out)
    process.stdout.write('\n')
  } catch (e: unknown) {
    await appendCliErrorLog(cwd, e).catch(() => {
      /* 日志写入失败时仍尽量退出 */
    })
    console.error(
      `执行失败：${formatChatError(e)}（完整信息已写入 ${localErrorLogPath(cwd)}）`,
    )
    exitCode = 1
  } finally {
    await mcp.stop().catch(() => {
      /* ignore */
    })
  }

  process.exit(exitCode)
}
