import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { GoogleGenerativeAI } from '@google/generative-ai'
import type { InfinitiConfig, LlmProfile, ThinkingConfig } from '../config/types.js'
import { resolveLlmProfile } from '../config/types.js'
import { BUILTIN_TOOLS } from '../tools/definitions.js'
import type { BuiltinToolName } from '../tools/definitions.js'
import { runBuiltinTool } from '../tools/runner.js'
import type { AgentToolSpec } from '../mcp/manager.js'
import type { PersistedMessage, UserFileAttachment } from './persisted.js'
import type { SeedanceReferenceImage } from '../video/generateSeedanceVideo.js'
import type { AvatarGenReferenceImage } from '../avatar/real2dAvatarGen.js'
import type { McpManager } from '../mcp/manager.js'
import type { EditHistory } from '../session/editHistory.js'
import type { ToolRunContext } from '../tools/runner.js'
import {
  CONFIRMABLE_BUILTIN_TOOLS,
  formatToolConfirmDetail,
} from './formatToolConfirm.js'
import { evaluateToolSafety } from './toolGateAgent.js'
import { agentDebug } from '../utils/agentDebug.js'
import {
  appendAssistantToolCalls,
  appendPendingToolResults,
  appendToolResult,
  failedToolResultJson,
  type PendingToolExecution,
} from './toolExecutionMessages.js'
import { OpenAiToolAccumulator } from './openAiToolAccumulator.js'

const MAX_TOOL_STEPS = 48
const DRY_RUN_SAFE_TOOLS = new Set<string>(['write_file', 'str_replace'])

const LLM_TIMEOUT_MS = 180_000
const LLM_MAX_RETRIES = 1
/** SSE 流闲置超时：连续无新事件即中断（参考 ref 的 STREAM_IDLE_TIMEOUT_MS） */
const STREAM_IDLE_TIMEOUT_MS = 90_000

function visionLocationText(m: Extract<PersistedMessage, { role: 'user' }>): string {
  const v = m.vision
  if (!v) return m.content
  const parts = [
    m.content,
    '',
    `[视觉快照] 已附带一张摄像头照片，拍摄时间：${v.capturedAt}。`,
  ]
  if (v.location) {
    const acc = typeof v.location.accuracy === 'number'
      ? `，精度约 ${Math.round(v.location.accuracy)} 米`
      : ''
    parts.push(
      `[地理位置] latitude=${v.location.latitude}, longitude=${v.location.longitude}${acc}。`,
    )
  }
  return parts.join('\n').trim()
}

function attachmentContextText(m: Extract<PersistedMessage, { role: 'user' }>): string {
  const attachments = m.attachments ?? []
  if (!attachments.length) return m.vision ? visionLocationText(m) : m.content
  const parts = [m.vision ? visionLocationText(m) : m.content, '', `[附件] 用户随本条消息上传了 ${attachments.length} 个附件：`]
  attachments.forEach((a, idx) => {
    const sizeKb = Math.max(1, Math.round(a.size / 1024))
    parts.push(`${idx + 1}. ${a.name} (${a.mediaType}, ${sizeKb} KB, ${a.kind})`)
    if (a.text?.trim()) {
      parts.push(`内容预览：\n${a.text.slice(0, 20_000)}`)
    }
  })
  return parts.join('\n').trim()
}

export function canBypassToolSafetyForDryRun(name: string, args: Record<string, unknown>): boolean {
  return DRY_RUN_SAFE_TOOLS.has(name) && args.dry_run === true
}

function imageAttachments(m: Extract<PersistedMessage, { role: 'user' }>): UserFileAttachment[] {
  return (m.attachments ?? []).filter((a) => a.kind === 'image' && a.mediaType.startsWith('image/'))
}

function documentAttachments(m: Extract<PersistedMessage, { role: 'user' }>): UserFileAttachment[] {
  return (m.attachments ?? []).filter((a) => a.kind === 'document')
}

function latestUserVision(messages: PersistedMessage[]): Extract<PersistedMessage, { role: 'user' }>['vision'] | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'user' && m.vision) return m.vision
    const firstImage = m.role === 'user' ? imageAttachments(m)[0] : undefined
    if (firstImage && (firstImage.mediaType === 'image/jpeg' || firstImage.mediaType === 'image/png' || firstImage.mediaType === 'image/webp')) {
      return {
        imageBase64: firstImage.base64,
        mediaType: firstImage.mediaType,
        capturedAt: firstImage.capturedAt,
      }
    }
  }
  return undefined
}

function latestSeedanceReferenceImages(messages: PersistedMessage[]): SeedanceReferenceImage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'user') continue
    const out: SeedanceReferenceImage[] = []
    if (m.vision) {
      out.push({
        mediaType: m.vision.mediaType,
        base64: m.vision.imageBase64,
        label: 'camera snapshot',
      })
    }
    for (const a of imageAttachments(m)) {
      if (a.mediaType === 'image/jpeg' || a.mediaType === 'image/png' || a.mediaType === 'image/webp') {
        out.push({
          mediaType: a.mediaType,
          base64: a.base64,
          label: a.name,
        })
      }
    }
    return out.slice(0, 9)
  }
  return []
}

function latestAvatarGenReferenceImages(messages: PersistedMessage[]): AvatarGenReferenceImage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'user') continue
    const out: AvatarGenReferenceImage[] = []
    if (m.vision) {
      out.push({
        mediaType: m.vision.mediaType,
        base64: m.vision.imageBase64,
        label: 'camera snapshot',
      })
    }
    for (const a of imageAttachments(m)) {
      if (a.mediaType === 'image/jpeg' || a.mediaType === 'image/png' || a.mediaType === 'image/webp') {
        out.push({
          mediaType: a.mediaType,
          base64: a.base64,
          label: a.name,
        })
      }
    }
    return out.slice(0, 4)
  }
  return []
}

function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `${label}：${Math.round(ms / 1000)} 秒内无响应。请检查网络、VPN、Base URL、模型名与 API Key。`,
        ),
      )
    }, ms)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) {
      clearTimeout(timer)
    }
  })
}

export type StreamCallbacks = {
  onTextDelta: (delta: string, fullText: string) => void
  onStreamReset?: () => void
  /** 模型 SSE 中 tool_use block 开始（参数仍在传输） */
  onToolUseStart?: (toolName: string) => void
  /** tool_use block 参数接收完毕，开始执行（流式工具执行） */
  onToolExecStart?: (toolName: string) => void
  onThinkingDelta?: (delta: string, fullThinking: string) => void
}

export type RunLoopOptions = {
  config: InfinitiConfig
  system: string
  messages: PersistedMessage[]
  cwd: string
  mcp: McpManager
  stream?: StreamCallbacks
  /** 跳过所有安全评估（--dangerously-skip-permissions） */
  skipPermissions?: boolean
  editHistory?: EditHistory
  memoryCoordinator?: ToolRunContext['memoryCoordinator']
  onToolDispatch?: (name: string) => void
  /** 外部中断信号（语音打断等场景） */
  signal?: AbortSignal
}

export async function runToolLoop(opts: RunLoopOptions): Promise<{
  messages: PersistedMessage[]
}> {
  const llm = resolveLlmProfile(opts.config)
  agentDebug('runToolLoop start', llm.provider, llm.model)
  const tools: AgentToolSpec[] = [
    ...BUILTIN_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
    ...opts.mcp.getToolSpecs(),
  ]

  const builtin = new Set<string>(BUILTIN_TOOLS.map((t) => t.name))

  const dispatch = async (name: string, argsJson: string): Promise<string> => {
    agentDebug('dispatch tool', name)

    if (!opts.skipPermissions) {
      let args: Record<string, unknown>
      try { args = JSON.parse(argsJson) as Record<string, unknown> } catch { args = {} }
      if (!canBypassToolSafetyForDryRun(name, args)) {
        const detail = CONFIRMABLE_BUILTIN_TOOLS.has(name)
          ? await formatToolConfirmDetail(name, args, opts.cwd)
          : `${name}(${JSON.stringify(args).slice(0, 2000)})`

        const gate = await evaluateToolSafety(opts.config, name, detail, opts.messages)

        if (gate.decision === 'deny') {
          return JSON.stringify({
            status: 'blocked',
            denied: true,
            reason: gate.reason,
            tool: name,
            instruction: '此操作被安全评估拒绝，不可执行。',
          })
        }
        if (gate.decision === 'ask') {
          return JSON.stringify({
            status: 'blocked',
            reason: gate.reason,
            tool: name,
            detail: detail.slice(0, 2000),
            instruction: '此操作需要用户确认。请将详情告知用户，获得明确确认后重试。',
          })
        }
      }
    }

    if (builtin.has(name)) {
      return runBuiltinTool(name as BuiltinToolName, argsJson, {
        sessionCwd: opts.cwd,
        config: opts.config,
        snapVision: latestUserVision(opts.messages),
        seedanceImages: latestSeedanceReferenceImages(opts.messages),
        avatarGenImages: latestAvatarGenReferenceImages(opts.messages),
        editHistory: opts.editHistory,
        memoryCoordinator: opts.memoryCoordinator,
      })
    }
    return opts.mcp.call(name, argsJson)
  }

  switch (llm.provider) {
    case 'anthropic':
      return runAnthropic(opts, llm, tools, dispatch)
    case 'openai':
    case 'minimax':
    case 'openrouter':
      return runOpenAI(opts, llm, tools, dispatch)
    case 'gemini':
      return runGemini(opts, llm, tools, dispatch)
    default: {
      const _: never = llm.provider
      throw new Error(`未知 provider: ${String(_)}`)
    }
  }
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

function toAnthropicMessages(
  messages: PersistedMessage[],
): Anthropic.Messages.MessageParam[] {
  const out: Anthropic.Messages.MessageParam[] = []
  let i = 0
  while (i < messages.length) {
    const m = messages[i]!
    if (m.role === 'user') {
      if (m.vision || m.attachments?.length) {
        const content: Anthropic.Messages.ContentBlockParam[] = [
          { type: 'text', text: attachmentContextText(m) },
        ]
        if (m.vision) {
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: m.vision.mediaType,
              data: m.vision.imageBase64,
            },
          })
        }
        for (const img of imageAttachments(m)) {
          if (img.mediaType === 'image/jpeg' || img.mediaType === 'image/png' || img.mediaType === 'image/webp' || img.mediaType === 'image/gif') {
            content.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: img.mediaType as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
                data: img.base64,
              },
            } as Anthropic.Messages.ContentBlockParam)
          }
        }
        for (const doc of documentAttachments(m)) {
          if (doc.mediaType === 'application/pdf') {
            content.push({
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: doc.base64,
              },
            } as unknown as Anthropic.Messages.ContentBlockParam)
          }
        }
        out.push({
          role: 'user',
          content,
        })
      } else {
        out.push({ role: 'user', content: m.content })
      }
      i++
      continue
    }
    if (m.role === 'assistant') {
      if (m.toolCalls?.length) {
        const blocks: Anthropic.Messages.ContentBlockParam[] = []
        if (m.content?.trim()) {
          blocks.push({ type: 'text', text: m.content })
        }
        for (const tc of m.toolCalls) {
          let input: Record<string, unknown> = {}
          try {
            input = JSON.parse(tc.argumentsJson || '{}') as Record<
              string,
              unknown
            >
          } catch {
            input = {}
          }
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input,
          })
        }
        out.push({ role: 'assistant', content: blocks })
      } else {
        out.push({
          role: 'assistant',
          content: m.content ?? '',
        })
      }
      i++
      continue
    }
    if (m.role === 'tool') {
      const results: Anthropic.Messages.ToolResultBlockParam[] = []
      while (i < messages.length && messages[i]!.role === 'tool') {
        const t = messages[i] as Extract<PersistedMessage, { role: 'tool' }>
        results.push({
          type: 'tool_result',
          tool_use_id: t.toolCallId,
          content: t.content,
        })
        i++
      }
      out.push({ role: 'user', content: results })
      continue
    }
  }
  return out
}

function resolveAnthropicThinking(
  cfg: ThinkingConfig | undefined,
): Anthropic.Messages.ThinkingConfigParam | undefined {
  const mode = cfg?.mode ?? 'adaptive'
  if (mode === 'disabled') return undefined
  if (mode === 'enabled') {
    const budget = Math.max(1024, cfg?.budgetTokens ?? 10_000)
    return { type: 'enabled', budget_tokens: budget }
  }
  return { type: 'adaptive' }
}

const THINKING_MAX_TOKENS = 16_000
const DEFAULT_MAX_TOKENS = 8192

/**
 * Anthropic 流式工具执行：参考 ref 的 StreamingToolExecutor 架构。
 *
 * 关键改进：
 * 1. 工具在 content_block_stop 时立即开始执行，不等 finalMessage
 * 2. 多工具并行执行
 * 3. SSE 流闲置超时 watchdog（90s 无新事件则中断）
 */
async function runAnthropic(
  opts: RunLoopOptions,
  llm: LlmProfile,
  tools: AgentToolSpec[],
  dispatch: (name: string, argsJson: string) => Promise<string>,
): Promise<{ messages: PersistedMessage[] }> {
  const client = new Anthropic({
    apiKey: llm.apiKey,
    baseURL: normalizeBaseUrl(llm.baseUrl),
    timeout: LLM_TIMEOUT_MS,
    maxRetries: LLM_MAX_RETRIES,
  })
  const anthropicTools: Anthropic.Messages.Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Messages.Tool['input_schema'],
  }))

  const thinking = resolveAnthropicThinking(opts.config.thinking)
  const maxTokens = thinking ? THINKING_MAX_TOKENS : DEFAULT_MAX_TOKENS
  agentDebug('anthropic thinking config', thinking?.type ?? 'none', 'max_tokens', maxTokens)

  const working: PersistedMessage[] = [...opts.messages]

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    agentDebug('anthropic step', step, 'request stream')
    opts.stream?.onStreamReset?.()

    const stream = client.messages.stream({
      model: llm.model,
      max_tokens: maxTokens,
      system: opts.system,
      messages: toAnthropicMessages(working),
      tools: anthropicTools,
      ...(thinking && { thinking }),
    })

    // ── 流式工具执行状态 ──
    const pendingTools: PendingToolExecution[] = []
    let curBlockType: 'tool_use' | 'thinking' | 'text' | null = null
    let curToolId = ''
    let curToolName = ''
    let curToolInput = ''
    let thinkingAcc = ''
    let lastEventAt = Date.now()

    // ── 外部中断 ──
    if (opts.signal?.aborted) {
      agentDebug('signal already aborted before stream start')
      break
    }
    const onAbort = () => {
      agentDebug('external abort signal received, aborting stream')
      stream.abort()
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    // ── SSE 流闲置 watchdog ──
    const idleCheck = setInterval(() => {
      if (Date.now() - lastEventAt > STREAM_IDLE_TIMEOUT_MS) {
        agentDebug('stream idle watchdog triggered, aborting')
        clearInterval(idleCheck)
        stream.abort()
      }
    }, 5_000)

    // ── 文本流回调 ──
    if (opts.stream) {
      stream.on('text', (delta, snapshot) => {
        lastEventAt = Date.now()
        opts.stream!.onTextDelta(delta, snapshot)
      })
    }

    // ── 流事件处理：工具在块结束时立即 dispatch ──
    stream.on('streamEvent', (event) => {
      lastEventAt = Date.now()

      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          curBlockType = 'tool_use'
          curToolId = event.content_block.id
          curToolName = event.content_block.name
          curToolInput = ''
          agentDebug('SSE tool_use block start', curToolName)
          opts.stream?.onToolUseStart?.(curToolName)
        } else if (event.content_block.type === 'thinking') {
          curBlockType = 'thinking'
          thinkingAcc = ''
        } else {
          curBlockType = 'text'
        }
      }

      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'input_json_delta' && curBlockType === 'tool_use') {
          curToolInput += event.delta.partial_json
        }
        if (event.delta.type === 'thinking_delta') {
          thinkingAcc += event.delta.thinking
          opts.stream?.onThinkingDelta?.(event.delta.thinking, thinkingAcc)
        }
      }

      if (event.type === 'content_block_stop') {
        if (curBlockType === 'tool_use' && curToolId) {
          const inputJson = curToolInput || '{}'

          agentDebug('streaming tool exec start', curToolName, curToolId)
          opts.stream?.onToolExecStart?.(curToolName)
          opts.onToolDispatch?.(curToolName)

          pendingTools.push({
            id: curToolId,
            name: curToolName,
            argumentsJson: inputJson,
            resultPromise: dispatch(curToolName, inputJson),
          })
        }
        curBlockType = null
        curToolId = ''
        curToolName = ''
        curToolInput = ''
      }
    })

    // ── 等待消息完成（工具已在后台并行执行） ──
    let msg: Anthropic.Messages.Message
    try {
      const final = await withDeadline(
        stream.finalMessage(),
        LLM_TIMEOUT_MS,
        'Anthropic',
      )
      msg = final as unknown as Anthropic.Messages.Message
    } catch (e) {
      if (pendingTools.length) {
        const error = e instanceof Error ? e.message : String(e)
        appendAssistantToolCalls(working, null, pendingTools)
        await appendPendingToolResults(
          working,
          pendingTools,
          (toolError) => failedToolResultJson('tool_failed_after_stream_error', toolError),
        )
        working.push({
          role: 'assistant',
          content: `Anthropic stream failed after tool dispatch: ${error}`,
        })
        return { messages: working }
      }
      throw e
    } finally {
      clearInterval(idleCheck)
      opts.signal?.removeEventListener('abort', onAbort)
    }

    if (opts.signal?.aborted) {
      const textParts: string[] = []
      for (const block of msg.content) {
        if (block.type === 'text') textParts.push(block.text)
      }
      const partial = textParts.join('\n').trim()
      if (partial) working.push({ role: 'assistant', content: partial })
      break
    }

    agentDebug(
      'anthropic step', step, 'finalMessage', 'blocks',
      msg.content.map((b) => b.type).join(','),
      'pendingTools', pendingTools.length,
    )

    // ── 从完整消息中提取文本 ──
    const textParts: string[] = []
    for (const block of msg.content) {
      if (block.type === 'text') textParts.push(block.text)
    }
    const mergedText = textParts.join('\n').trim() || null

    if (!pendingTools.length) {
      working.push({ role: 'assistant', content: mergedText })
      break
    }

    appendAssistantToolCalls(working, mergedText, pendingTools)

    // ── 等待所有工具结果（大部分已在流式期间完成） ──
    await appendPendingToolResults(working, pendingTools)
  }

  return { messages: working }
}

function toOpenAIMessages(
  messages: PersistedMessage[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.vision || m.attachments?.length) {
        const content: unknown[] = [{ type: 'text', text: attachmentContextText(m) }]
        if (m.vision) {
          content.push({
            type: 'image_url',
            image_url: {
              url: `data:${m.vision.mediaType};base64,${m.vision.imageBase64}`,
            },
          })
        }
        for (const img of imageAttachments(m)) {
          content.push({
            type: 'image_url',
            image_url: {
              url: `data:${img.mediaType};base64,${img.base64}`,
            },
          })
        }
        for (const doc of documentAttachments(m)) {
          content.push({
            type: 'file',
            file: {
              filename: doc.name,
              file_data: `data:${doc.mediaType};base64,${doc.base64}`,
            },
          })
        }
        out.push({
          role: 'user',
          content: content as OpenAI.Chat.ChatCompletionContentPart[],
        } as OpenAI.Chat.ChatCompletionMessageParam)
      } else {
        out.push({ role: 'user', content: m.content })
      }
    } else if (m.role === 'assistant') {
      if (m.toolCalls?.length) {
        out.push({
          role: 'assistant',
          content: m.content?.trim() ? m.content : null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: tc.argumentsJson || '{}',
            },
          })),
        })
      } else {
        out.push({
          role: 'assistant',
          content: m.content ?? '',
        })
      }
    } else if (m.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: m.content,
      })
    }
  }
  return out
}

async function runOpenAI(
  opts: RunLoopOptions,
  llm: LlmProfile,
  tools: AgentToolSpec[],
  dispatch: (name: string, argsJson: string) => Promise<string>,
): Promise<{ messages: PersistedMessage[] }> {
  const client = new OpenAI({
    apiKey: llm.apiKey,
    baseURL: normalizeBaseUrl(llm.baseUrl),
    timeout: LLM_TIMEOUT_MS,
    maxRetries: LLM_MAX_RETRIES,
  })

  const useTools = !llm.disableTools
  const openaiTools: OpenAI.Chat.ChatCompletionTool[] = tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))

  const working: PersistedMessage[] = [...opts.messages]

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    if (opts.signal?.aborted) break
    agentDebug('openai step', step, 'request stream', useTools ? 'with tools' : 'no tools')
    opts.stream?.onStreamReset?.()
    const streamResp = await client.chat.completions.create({
      model: llm.model,
      messages: [
        { role: 'system', content: opts.system },
        ...toOpenAIMessages(working),
      ],
      ...(useTools
        ? { tools: openaiTools, parallel_tool_calls: true as const }
        : {}),
      stream: true,
    })

    let content = ''
    const toolAcc = new OpenAiToolAccumulator()

    await withDeadline(
      (async () => {
        for await (const chunk of streamResp) {
          if (opts.signal?.aborted) break
          const choice = chunk.choices[0]
          if (!choice) {
            continue
          }
          const d = choice.delta
          if (d.content) {
            content += d.content
            opts.stream?.onTextDelta(d.content, content)
          }
          if (d.tool_calls) {
            for (const tc of d.tool_calls) {
              toolAcc.add(tc)
            }
          }
        }
      })(),
      LLM_TIMEOUT_MS,
      'OpenAI',
    )

    if (opts.signal?.aborted) {
      if (content.trim()) working.push({ role: 'assistant', content })
      break
    }

    const fnCalls = toolAcc.toToolCalls()
    agentDebug(
      'openai step',
      step,
      'stream done',
      'toolCalls',
      fnCalls.map((c) => c.name).join(',') || '(none)',
    )

    if (!fnCalls.length) {
      working.push({
        role: 'assistant',
        content,
      })
      break
    }

    appendAssistantToolCalls(
      working,
      content.trim() ? content : null,
      fnCalls,
    )

    for (const c of fnCalls) {
      const out = await dispatch(c.name, c.argumentsJson)
      appendToolResult(working, c, out)
    }
  }

  return { messages: working }
}

type GeminiPart = {
  text?: string
  inlineData?: { mimeType: string; data: string }
  functionCall?: { name: string; args: Record<string, unknown> }
  functionResponse?: {
    name: string
    response: { result: string }
  }
}

type GeminiContent = { role: string; parts: GeminiPart[] }

function toGeminiContents(messages: PersistedMessage[]): GeminiContent[] {
  const contents: GeminiContent[] = []
  let i = 0
  while (i < messages.length) {
    const m = messages[i]!
    if (m.role === 'user') {
      const parts: GeminiPart[] = [{ text: m.vision || m.attachments?.length ? attachmentContextText(m) : m.content }]
      if (m.vision) {
        parts.push({
          inlineData: {
            mimeType: m.vision.mediaType,
            data: m.vision.imageBase64,
          },
        })
      }
      for (const img of imageAttachments(m)) {
        parts.push({
          inlineData: {
            mimeType: img.mediaType,
            data: img.base64,
          },
        })
      }
      for (const doc of documentAttachments(m)) {
        parts.push({
          inlineData: {
            mimeType: doc.mediaType,
            data: doc.base64,
          },
        })
      }
      contents.push({ role: 'user', parts })
      i++
      continue
    }
    if (m.role === 'assistant') {
      const parts: GeminiPart[] = []
      if (m.content?.trim()) {
        parts.push({ text: m.content })
      }
      if (m.toolCalls?.length) {
        for (const tc of m.toolCalls) {
          let args: Record<string, unknown> = {}
          try {
            args = JSON.parse(tc.argumentsJson || '{}') as Record<
              string,
              unknown
            >
          } catch {
            args = {}
          }
          parts.push({
            functionCall: {
              name: tc.name,
              args,
            },
          })
        }
      }
      contents.push({ role: 'model', parts })
      i++
      continue
    }
    if (m.role === 'tool') {
      const parts: GeminiPart[] = []
      while (i < messages.length && messages[i]!.role === 'tool') {
        const t = messages[i] as Extract<PersistedMessage, { role: 'tool' }>
        parts.push({
          functionResponse: {
            name: t.name,
            response: { result: t.content },
          },
        })
        i++
      }
      contents.push({ role: 'user', parts })
      continue
    }
  }
  return contents
}

async function runGemini(
  opts: RunLoopOptions,
  llm: LlmProfile,
  tools: AgentToolSpec[],
  dispatch: (name: string, argsJson: string) => Promise<string>,
): Promise<{ messages: PersistedMessage[] }> {
  const genAI = new GoogleGenerativeAI(llm.apiKey)
  const decls = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters as Record<string, unknown>,
  }))

  const model = genAI.getGenerativeModel({
    model: llm.model,
    tools: [
      {
        functionDeclarations: decls as Parameters<
          typeof genAI.getGenerativeModel
        >[0]['tools'] extends Array<{ functionDeclarations?: infer F }>
          ? F
          : never,
      },
    ],
    systemInstruction: opts.system,
  })

  const working: PersistedMessage[] = [...opts.messages]

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    if (opts.signal?.aborted) break
    agentDebug('gemini step', step, 'request stream')
    opts.stream?.onStreamReset?.()
    const streamResult = await model.generateContentStream({
      contents: toGeminiContents(working) as never,
    })

    await withDeadline(
      (async () => {
        let acc = ''
        for await (const chunk of streamResult.stream) {
          if (opts.signal?.aborted) break
          let piece = ''
          try {
            piece = chunk.text()
          } catch {
            piece = ''
          }
          if (piece) {
            acc += piece
            opts.stream?.onTextDelta(piece, acc)
          }
        }
      })(),
      LLM_TIMEOUT_MS,
      'Gemini',
    )

    const response = await streamResult.response
    const parts = response.candidates?.[0]?.content?.parts ?? []

    const textChunks: string[] = []
    const calls: { name: string; args: Record<string, unknown> }[] = []

    for (const p of parts) {
      const part = p as { text?: string; functionCall?: { name: string; args?: Record<string, unknown> } }
      if (part.text) {
        textChunks.push(part.text)
      }
      if (part.functionCall?.name) {
        calls.push({
          name: part.functionCall.name,
          args: part.functionCall.args ?? {},
        })
      }
    }

    const mergedText = textChunks.join('').trim() || null
    agentDebug(
      'gemini step',
      step,
      'response',
      'tools',
      calls.map((c) => c.name).join(',') || '(none)',
    )

    if (!calls.length) {
      working.push({ role: 'assistant', content: mergedText })
      break
    }

    const toolCalls = calls.map((c, idx) => ({
      id: `gemini-${step}-${idx}-${c.name}`,
      name: c.name,
      argumentsJson: JSON.stringify(c.args ?? {}),
    }))

    appendAssistantToolCalls(working, mergedText, toolCalls)

    for (let j = 0; j < calls.length; j++) {
      const c = calls[j]!
      const tc = toolCalls[j]!
      const out = await dispatch(c.name, JSON.stringify(c.args ?? {}))
      appendToolResult(working, tc, out)
    }
  }

  return { messages: working }
}
