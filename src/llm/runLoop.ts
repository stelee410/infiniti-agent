import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { GoogleGenerativeAI } from '@google/generative-ai'
import type { InfinitiConfig, ThinkingConfig } from '../config/types.js'
import { BUILTIN_TOOLS } from '../tools/definitions.js'
import type { BuiltinToolName } from '../tools/definitions.js'
import { runBuiltinTool } from '../tools/runner.js'
import type { AgentToolSpec } from '../mcp/manager.js'
import type { PersistedMessage } from './persisted.js'
import type { McpManager } from '../mcp/manager.js'
import type { EditHistory } from '../session/editHistory.js'
import {
  CONFIRMABLE_BUILTIN_TOOLS,
  formatToolConfirmDetail,
} from './formatToolConfirm.js'
import { agentDebug } from '../utils/agentDebug.js'

const MAX_TOOL_STEPS = 48

/** SDK 默认约 10 分钟 + 重试，在错误 Base URL / 网络不通时会像「死机」；这里收紧。 */
const LLM_TIMEOUT_MS = 180_000
const LLM_MAX_RETRIES = 1

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

/** LLM 侧 SSE/流式 token；用于 TUI 实时输出 */
export type StreamCallbacks = {
  onTextDelta: (delta: string, fullText: string) => void
  /** 新一轮 API 请求前清空 UI 缓冲区（含工具轮次之间） */
  onStreamReset?: () => void
  /** 模型开始生成 tool_use block（还在 SSE 中，尚未结束） */
  onToolUseStart?: (toolName: string) => void
  /** Extended thinking：思考过程增量回调 */
  onThinkingDelta?: (delta: string, fullThinking: string) => void
}

export type RunLoopOptions = {
  config: InfinitiConfig
  system: string
  messages: PersistedMessage[]
  cwd: string
  mcp: McpManager
  stream?: StreamCallbacks
  /** 对 write_file / str_replace / bash / http_request 等在执行前请求用户确认（dry_run 跳过） */
  confirmTool?: (info: { name: string; detail: string }) => Promise<boolean>
  /** 成功写入后压栈，供 TUI /undo 恢复 */
  editHistory?: EditHistory
  /** 用户确认通过后、实际执行工具前（便于 TUI 区分「等模型」与「跑工具」） */
  onToolDispatch?: (name: string) => void
}

export async function runToolLoop(opts: RunLoopOptions): Promise<{
  messages: PersistedMessage[]
}> {
  agentDebug('runToolLoop start', opts.config.llm.provider, opts.config.llm.model)
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
    let args: Record<string, unknown>
    try {
      args = JSON.parse(argsJson) as Record<string, unknown>
    } catch {
      return JSON.stringify({ ok: false, error: '工具参数不是合法 JSON' })
    }

    const skipConfirm = args.dry_run === true
    if (
      builtin.has(name) &&
      CONFIRMABLE_BUILTIN_TOOLS.has(name) &&
      !skipConfirm &&
      opts.confirmTool
    ) {
      agentDebug('awaiting user confirm for tool', name)
      const detail = await formatToolConfirmDetail(name, args, opts.cwd)
      const approved = await opts.confirmTool({ name, detail })
      if (!approved) {
        return JSON.stringify({ ok: false, error: '用户拒绝了工具执行' })
      }
    }

    agentDebug('run tool', name)
    opts.onToolDispatch?.(name)

    if (builtin.has(name)) {
      return runBuiltinTool(name as BuiltinToolName, argsJson, {
        sessionCwd: opts.cwd,
        editHistory: opts.editHistory,
      })
    }
    return opts.mcp.call(name, argsJson)
  }

  switch (opts.config.llm.provider) {
    case 'anthropic':
      return runAnthropic(opts, tools, dispatch)
    case 'openai':
      return runOpenAI(opts, tools, dispatch)
    case 'gemini':
      return runGemini(opts, tools, dispatch)
    default: {
      const _: never = opts.config.llm.provider
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
      out.push({ role: 'user', content: m.content })
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

async function runAnthropic(
  opts: RunLoopOptions,
  tools: AgentToolSpec[],
  dispatch: (name: string, argsJson: string) => Promise<string>,
): Promise<{ messages: PersistedMessage[] }> {
  const client = new Anthropic({
    apiKey: opts.config.llm.apiKey,
    baseURL: normalizeBaseUrl(opts.config.llm.baseUrl),
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
      model: opts.config.llm.model,
      max_tokens: maxTokens,
      system: opts.system,
      messages: toAnthropicMessages(working),
      tools: anthropicTools,
      ...(thinking && { thinking }),
    })
    if (opts.stream) {
      let thinkingAcc = ''
      stream.on('text', (delta, snapshot) => {
        opts.stream!.onTextDelta(delta, snapshot)
      })
      stream.on('streamEvent', (event) => {
        if (
          event.type === 'content_block_start' &&
          event.content_block.type === 'tool_use'
        ) {
          agentDebug('anthropic SSE tool_use block start', event.content_block.name)
          opts.stream!.onToolUseStart?.(event.content_block.name)
        }
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'thinking_delta'
        ) {
          thinkingAcc += event.delta.thinking
          opts.stream!.onThinkingDelta?.(event.delta.thinking, thinkingAcc)
        }
        if (
          event.type === 'content_block_start' &&
          event.content_block.type === 'thinking'
        ) {
          thinkingAcc = ''
        }
      })
    }
    const final = await withDeadline(
      stream.finalMessage(),
      LLM_TIMEOUT_MS,
      'Anthropic',
    )
    const msg = final as unknown as Anthropic.Messages.Message
    agentDebug(
      'anthropic step',
      step,
      'finalMessage',
      'blocks',
      msg.content.map((b) => b.type).join(','),
    )

    const textParts: string[] = []
    const toolUses: { id: string; name: string; input: Record<string, unknown> }[] =
      []

    for (const block of msg.content) {
      if (block.type === 'text') {
        textParts.push(block.text)
      }
      if (block.type === 'tool_use') {
        toolUses.push({
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        })
      }
      // thinking / redacted_thinking blocks are intentionally skipped
      // from persisted messages — they are surfaced via stream callbacks only
    }

    const mergedText = textParts.join('\n').trim() || null

    if (!toolUses.length) {
      working.push({ role: 'assistant', content: mergedText })
      break
    }

    working.push({
      role: 'assistant',
      content: mergedText,
      toolCalls: toolUses.map((tu) => ({
        id: tu.id,
        name: tu.name,
        argumentsJson: JSON.stringify(tu.input ?? {}),
      })),
    })

    for (const tu of toolUses) {
      const out = await dispatch(tu.name, JSON.stringify(tu.input ?? {}))
      working.push({
        role: 'tool',
        toolCallId: tu.id,
        name: tu.name,
        content: out,
      })
    }
  }

  return { messages: working }
}

function toOpenAIMessages(
  messages: PersistedMessage[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content })
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
  tools: AgentToolSpec[],
  dispatch: (name: string, argsJson: string) => Promise<string>,
): Promise<{ messages: PersistedMessage[] }> {
  const client = new OpenAI({
    apiKey: opts.config.llm.apiKey,
    baseURL: normalizeBaseUrl(opts.config.llm.baseUrl),
    timeout: LLM_TIMEOUT_MS,
    maxRetries: LLM_MAX_RETRIES,
  })

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
    agentDebug('openai step', step, 'request stream')
    opts.stream?.onStreamReset?.()
    const streamResp = await client.chat.completions.create({
      model: opts.config.llm.model,
      messages: [
        { role: 'system', content: opts.system },
        ...toOpenAIMessages(working),
      ],
      tools: openaiTools,
      parallel_tool_calls: true,
      stream: true,
    })

    let content = ''
    const toolAcc = new Map<
      number,
      { id: string; name: string; arguments: string }
    >()

    await withDeadline(
      (async () => {
        for await (const chunk of streamResp) {
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
              const i = tc.index
              const cur = toolAcc.get(i) ?? {
                id: '',
                name: '',
                arguments: '',
              }
              if (tc.id) {
                cur.id = tc.id
              }
              if (tc.function?.name) {
                cur.name = tc.function.name
              }
              if (tc.function?.arguments) {
                cur.arguments += tc.function.arguments
              }
              toolAcc.set(i, cur)
            }
          }
        }
      })(),
      LLM_TIMEOUT_MS,
      'OpenAI',
    )

    const sorted = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v)
    const fnCalls = sorted.filter((v) => v.id && v.name)
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

    working.push({
      role: 'assistant',
      content: content.trim() ? content : null,
      toolCalls: fnCalls.map((c) => ({
        id: c.id,
        name: c.name,
        argumentsJson: c.arguments || '{}',
      })),
    })

    for (const c of fnCalls) {
      const out = await dispatch(c.name, c.arguments || '{}')
      working.push({
        role: 'tool',
        toolCallId: c.id,
        name: c.name,
        content: out,
      })
    }
  }

  return { messages: working }
}

type GeminiPart = {
  text?: string
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
      contents.push({ role: 'user', parts: [{ text: m.content }] })
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
  tools: AgentToolSpec[],
  dispatch: (name: string, argsJson: string) => Promise<string>,
): Promise<{ messages: PersistedMessage[] }> {
  const genAI = new GoogleGenerativeAI(opts.config.llm.apiKey)
  const decls = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters as Record<string, unknown>,
  }))

  const model = genAI.getGenerativeModel({
    model: opts.config.llm.model,
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
    agentDebug('gemini step', step, 'request stream')
    opts.stream?.onStreamReset?.()
    const streamResult = await model.generateContentStream({
      contents: toGeminiContents(working) as never,
    })

    await withDeadline(
      (async () => {
        let acc = ''
        for await (const chunk of streamResult.stream) {
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

    working.push({
      role: 'assistant',
      content: mergedText,
      toolCalls,
    })

    for (let j = 0; j < calls.length; j++) {
      const c = calls[j]!
      const tc = toolCalls[j]!
      const out = await dispatch(c.name, JSON.stringify(c.args ?? {}))
      working.push({
        role: 'tool',
        toolCallId: tc.id,
        name: c.name,
        content: out,
      })
    }
  }

  return { messages: working }
}
