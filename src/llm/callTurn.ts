import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { InfinitiConfig } from '../config/types.js'
import { resolveLlmProfile } from '../config/types.js'
import type { PersistedMessage } from './persisted.js'
import { toOpenAIMessages } from './runLoop.js'

const CALL_TURN_TIMEOUT_MS = 60_000
const CALL_TURN_MAX_RETRIES = 0

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

export type CallTurnStream = {
  onTextDelta?: (delta: string, full: string) => void
  /** 流式过程中可以多次回调，最后一次 onDone 给出最终文本。 */
  onDone?: (full: string) => void
}

export type CallTurnOptions = {
  config: InfinitiConfig
  system: string
  /** 不含 system 的对话历史 + 当前用户输入。 */
  messages: PersistedMessage[]
  signal?: AbortSignal
  stream?: CallTurnStream
  /** 哪个 LLM profile；默认 default。 */
  profile?: string
}

/**
 * 通话模式单轮：流式 LLM 文本回复，**不带 tools**、**不走 tool loop**，
 * 拿到 stream done 即结束。失败抛错；上层决定怎么兜底。
 */
export async function runCallTurn(opts: CallTurnOptions): Promise<string> {
  const llm = resolveLlmProfile(opts.config, opts.profile)
  if (llm.provider === 'anthropic') {
    return await runCallTurnAnthropic(opts, llm)
  }
  return await runCallTurnOpenAI(opts, llm)
}

async function runCallTurnOpenAI(
  opts: CallTurnOptions,
  llm: ReturnType<typeof resolveLlmProfile>,
): Promise<string> {
  const client = new OpenAI({
    apiKey: llm.apiKey,
    baseURL: normalizeBaseUrl(llm.baseUrl),
    timeout: CALL_TURN_TIMEOUT_MS,
    maxRetries: CALL_TURN_MAX_RETRIES,
  })
  const requestBody = {
    model: llm.model,
    messages: [
      { role: 'system' as const, content: opts.system },
      ...toOpenAIMessages(opts.messages),
    ],
    stream: true as const,
  }
  const streamResp = await client.chat.completions.create(requestBody, {
    signal: opts.signal,
  })
  let full = ''
  for await (const chunk of streamResp) {
    if (opts.signal?.aborted) break
    const delta = chunk.choices[0]?.delta?.content
    if (delta) {
      full += delta
      opts.stream?.onTextDelta?.(delta, full)
    }
  }
  opts.stream?.onDone?.(full)
  return full
}

async function runCallTurnAnthropic(
  opts: CallTurnOptions,
  llm: ReturnType<typeof resolveLlmProfile>,
): Promise<string> {
  const client = new Anthropic({
    apiKey: llm.apiKey,
    baseURL: normalizeBaseUrl(llm.baseUrl),
    timeout: CALL_TURN_TIMEOUT_MS,
    maxRetries: CALL_TURN_MAX_RETRIES,
  })
  const stream = await client.messages.stream({
    model: llm.model,
    max_tokens: 1024,
    system: opts.system,
    messages: opts.messages
      .filter((m) => m.role !== 'tool')
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' as const : 'user' as const,
        content: typeof (m as { content?: unknown }).content === 'string'
          ? ((m as { content: string }).content)
          : '',
      })),
  })
  let full = ''
  for await (const ev of stream) {
    if (opts.signal?.aborted) break
    if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
      const delta = ev.delta.text
      full += delta
      opts.stream?.onTextDelta?.(delta, full)
    }
  }
  opts.stream?.onDone?.(full)
  return full
}
