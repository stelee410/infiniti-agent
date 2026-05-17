import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ensureLocalAgentDir } from './config/io.js'
import type { InfinitiConfig } from './config/types.js'
import { McpManager } from './mcp/manager.js'
import { loadAgentPromptDocs, buildAgentSystemPrompt } from './prompt/loadProjectPrompt.js'
import { runToolLoop } from './llm/runLoop.js'
import type { PersistedMessage } from './llm/persisted.js'
import { loadSession, saveSession } from './session/file.js'
import { archiveSession } from './session/archive.js'
import { EditHistory } from './session/editHistory.js'
import { loadSkillsForCwd, skillsToSystemBlock } from './skills/loader.js'
import { localErrorLogPath } from './paths.js'
import { formatChatError } from './utils/formatError.js'
import { estimateRequestTokens } from './llm/estimateTokens.js'
import { resolvedCompactionSettings } from './llm/compactionSettings.js'
import { buildSystemWithMemory } from './prompt/systemBuilder.js'
import { SubconsciousAgent } from './subconscious/agent.js'
import { BUILTIN_TOOLS } from './tools/definitions.js'
import { isRecoverableUpstreamError } from './llm/recoverableError.js'

async function buildCliSystem(
  config: InfinitiConfig,
  cwd: string,
  subconscious: SubconsciousAgent,
  query: string,
): Promise<string> {
  return buildSystemWithMemory(config, cwd, subconscious, query)
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
  const subconscious = new SubconsciousAgent(config, cwd)
  let messages: PersistedMessage[] = []

  try {
    await subconscious.start()
    await mcp.start(config)

    try {
      const s = await loadSession(cwd)
      if (s?.messages?.length) {
        messages = s.messages
      }
    } catch (e: unknown) {
      throw e
    }

    const compSettings = resolvedCompactionSettings(config)
    const system = await buildCliSystem(config, cwd, subconscious, prompt)
    const compactIfOver = async (
      msgs: PersistedMessage[],
      threshold: number,
      reason: string,
    ): Promise<PersistedMessage[]> => {
      if (threshold <= 0) return msgs
      const tokens = estimateRequestTokens({ system, tools: BUILTIN_TOOLS, messages: msgs })
      if (tokens < threshold) return msgs
      console.error(`[cli] ${reason}: ${tokens} tokens >= ${threshold}，正在压缩…`)
      try {
        return await subconscious.compactSessionAsync({
          messages: msgs,
          minTailMessages: compSettings.minTailMessages,
          maxToolSnippetChars: compSettings.maxToolSnippetChars,
          preCompactHook: compSettings.preCompactHook,
        })
      } catch (e: unknown) {
        console.error(`[cli] 自动压缩失败，使用原会话继续: ${formatChatError(e)}`)
        return msgs
      }
    }

    messages = await compactIfOver(messages, compSettings.autoThresholdTokens, '自动压缩触发')

    await subconscious.observeUserInput(prompt)
    let nextMsgs: PersistedMessage[] = [
      ...messages,
      { role: 'user', content: prompt },
    ]

    const callRunToolLoop = (msgs: PersistedMessage[]) => runToolLoop({
      config,
      system,
      messages: msgs,
      cwd,
      mcp,
      editHistory,
      memoryCoordinator: subconscious,
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

    let out: PersistedMessage[]
    try {
      out = (await callRunToolLoop(nextMsgs)).messages
    } catch (e: unknown) {
      if (!isRecoverableUpstreamError(e) || compSettings.autoThresholdTokens <= 0) {
        throw e
      }
      console.error(`[cli] LLM 调用失败 (${formatChatError(e)})，尝试 emergency compact 后重试…`)
      // Force compact regardless of threshold — upstream said no, shrink and try once more.
      const compacted = await subconscious.compactSessionAsync({
        messages,
        minTailMessages: compSettings.minTailMessages,
        maxToolSnippetChars: compSettings.maxToolSnippetChars,
        preCompactHook: compSettings.preCompactHook,
      }).catch((compactErr) => {
        console.error(`[cli] emergency compact 失败: ${formatChatError(compactErr)}`)
        return messages
      })
      messages = compacted
      nextMsgs = [...compacted, { role: 'user', content: prompt }]
      out = (await callRunToolLoop(nextMsgs)).messages
    }
    await saveSession(cwd, out)
    const last = out[out.length - 1]
    if (last?.role === 'assistant' && last.content) {
      await subconscious.observeAssistantOutput(last.content)
    }
    await subconscious.consolidateFromMessages(out)
    await subconscious.heartbeat()
    await subconscious.waitForIdle()
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
