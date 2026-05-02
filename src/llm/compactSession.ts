import { spawn } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import type { InfinitiConfig } from '../config/types.js'
import { messagesToCompactTranscript, truncateTranscriptAtBoundary } from './messagesTranscript.js'
import { oneShotTextCompletion } from './oneShotCompletion.js'
import type { PersistedMessage } from './persisted.js'
import { agentDebug } from '../utils/agentDebug.js'

const PRECOMPACT_TIMEOUT_MS = 15_000
const MAX_TRANSCRIPT_CHARS = 400_000
const MAX_SUMMARY_CHARS = 24_000

const COMPACT_SUMMARY_SYSTEM = `你是对话压缩助手。输入是按时间线展开的 CLI Agent 会话转写（含用户、助手、工具名与节选结果）。

请输出一份高密度中文摘要，供后续模型继续任务。必须覆盖：
- 已认定的目标与结论
- 修改或涉及过的文件路径
- 未竟事项与待办
- 关键错误与修复方式
- 用户明确约束或偏好

不要寒暄。使用 Markdown 小标题与列表。控制在 8000 字以内。`

export function validateMessageSuffix(
  messages: PersistedMessage[],
  start: number,
): boolean {
  const n = messages.length
  let i = start
  while (i < n) {
    const m = messages[i]!
    if (m.role === 'tool') {
      return false
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const needed = new Set(m.toolCalls.map((t) => t.id))
      i++
      while (i < n && messages[i]!.role === 'tool') {
        const t = messages[i] as Extract<PersistedMessage, { role: 'tool' }>
        if (!needed.has(t.toolCallId)) {
          return false
        }
        needed.delete(t.toolCallId)
        i++
      }
      if (needed.size > 0) {
        return false
      }
      continue
    }
    i++
  }
  return true
}

/**
 * 返回分割点 split：messages.slice(split) 为保留后缀，前缀参与摘要。
 * 保证后缀以合法消息开头且工具链完整。
 */
export function findSafeCompactSplitIndex(
  messages: PersistedMessage[],
  minTailMessages: number,
): number | null {
  if (messages.length < 2) {
    return null
  }
  const minKeep = Math.min(
    messages.length - 1,
    Math.max(4, minTailMessages),
  )
  for (let extra = 0; extra <= messages.length; extra++) {
    let s = messages.length - minKeep - extra
    if (s <= 0) {
      return null
    }
    while (s < messages.length && messages[s]!.role === 'tool') {
      s--
    }
    if (s <= 0) {
      return null
    }
    if (validateMessageSuffix(messages, s)) {
      return s
    }
  }
  return null
}

async function runPreCompactHookExec(
  hookPath: string,
  cwd: string,
  stdin: string,
): Promise<string> {
  const abs = isAbsolute(hookPath) ? hookPath : resolve(cwd, hookPath)
  return new Promise((resolvePromise, reject) => {
    const child = spawn(abs, [], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
    })
    let out = ''
    let err = ''
    let settled = false
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      if (!settled) {
        settled = true
        reject(new Error(`preCompactHook 超时（${PRECOMPACT_TIMEOUT_MS}ms）`))
      }
    }, PRECOMPACT_TIMEOUT_MS)
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString('utf8')
      if (out.length > 2 * 1024 * 1024) {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }
    })
    child.stderr?.on('data', (d: Buffer) => {
      err += d.toString('utf8')
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      if (!settled) {
        settled = true
        reject(
          new Error(`preCompactHook 执行失败 (${abs}): ${e.message ?? String(e)}`),
        )
      }
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (settled) {
        return
      }
      settled = true
      if (code !== 0 && code !== null) {
        reject(
          new Error(
            `preCompactHook 退出码 ${code} (${abs}): ${err.trim() || out.slice(0, 500)}`,
          ),
        )
        return
      }
      resolvePromise(out.trim())
    })
    child.stdin?.write(stdin, 'utf8')
    child.stdin?.end()
  })
}

export type CompactSessionOptions = {
  config: InfinitiConfig
  cwd: string
  messages: PersistedMessage[]
  minTailMessages: number
  maxToolSnippetChars: number
  customInstructions?: string
  preCompactHook?: string
}

export async function compactSessionMessages(
  opts: CompactSessionOptions,
): Promise<PersistedMessage[]> {
  const startedAt = Date.now()
  const split = findSafeCompactSplitIndex(opts.messages, opts.minTailMessages)
  if (split === null) {
    agentDebug('[compact-session] no safe split', {
      messages: opts.messages.length,
      minTailMessages: opts.minTailMessages,
    })
    throw new Error(
      '无法安全压缩：历史过短，或无法在保留工具链的前提下分割（可调大 compaction.minTailMessages 再试）',
    )
  }
  const head = opts.messages.slice(0, split)
  const tail = opts.messages.slice(split)
  if (head.length === 0) {
    agentDebug('[compact-session] empty head', { messages: opts.messages.length, split })
    throw new Error('没有可摘要的历史')
  }

  let transcript = messagesToCompactTranscript(head, opts.maxToolSnippetChars)
  transcript = truncateTranscriptAtBoundary(transcript, MAX_TRANSCRIPT_CHARS)
  agentDebug('[compact-session] request summary', {
    messages: opts.messages.length,
    split,
    headMessages: head.length,
    tailMessages: tail.length,
    transcriptChars: transcript.length,
    maxToolSnippetChars: opts.maxToolSnippetChars,
    customInstructions: Boolean(opts.customInstructions?.trim()),
    preCompactHook: Boolean(opts.preCompactHook),
  })

  let hookAddendum = ''
  if (opts.preCompactHook) {
    hookAddendum = await runPreCompactHookExec(
      opts.preCompactHook,
      opts.cwd,
      transcript,
    )
  }

  const userParts: string[] = [
    '以下是一段 Infiniti Agent 会话转写（时间顺序）。请生成摘要。',
    '',
    transcript,
  ]
  if (opts.customInstructions?.trim()) {
    userParts.push('', '## 用户附加要求', opts.customInstructions.trim())
  }
  if (hookAddendum) {
    userParts.push('', '## Pre-compact 钩子补充（stdout）', hookAddendum)
  }

  let summary = await oneShotTextCompletion({
    config: opts.config,
    system: COMPACT_SUMMARY_SYSTEM,
    user: userParts.join('\n'),
    maxOutTokens: 8192,
    profile: 'compact',
  })
  if (summary.length > MAX_SUMMARY_CHARS) {
    summary = `${summary.slice(0, MAX_SUMMARY_CHARS)}\n…（摘要已截断）`
  }
  if (!summary.trim()) {
    agentDebug('[compact-session] empty summary')
    throw new Error('模型返回空摘要')
  }

  const header =
    '## [会话压缩摘要]\n\n' +
    summary.trim() +
    '\n\n（以上为此前轮次摘要；下接最近对话与工具链，可直接继续任务。）'

  const next: PersistedMessage[] = tail[0]?.role === 'user'
    ? [
      {
        role: 'user',
        content: `${header}\n\n---\n\n${tail[0].content}`,
      },
      ...tail.slice(1),
    ]
    : [{ role: 'user', content: header }, ...tail]

  agentDebug('[compact-session] summary complete', {
    beforeMessages: opts.messages.length,
    afterMessages: next.length,
    summaryChars: summary.length,
    durationMs: Date.now() - startedAt,
  })
  return next
}
