import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { GoogleGenerativeAI } from '@google/generative-ai'
import type { InfinitiConfig } from '../config/types.js'
import { resolveLlmProfile } from '../config/types.js'

const ONESHOT_TIMEOUT_MS = 120_000
const ONESHOT_MAX_RETRIES = 1

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `${label}：${Math.round(ms / 1000)} 秒内无响应。`,
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

export type OneShotParams = {
  config: InfinitiConfig
  system: string
  user: string
  maxOutTokens?: number
  /** 指定使用哪个 LLM profile（不传则用 default） */
  profile?: string
}

/** 无工具、无流式的单次补全（用于会话压缩、meta-agent 等） */
export async function oneShotTextCompletion(
  opts: OneShotParams,
): Promise<string> {
  const maxOut = Math.min(8192, Math.max(256, opts.maxOutTokens ?? 4096))
  const llm = resolveLlmProfile(opts.config, opts.profile)

  if (llm.provider === 'anthropic') {
    const client = new Anthropic({
      apiKey: llm.apiKey,
      baseURL: normalizeBaseUrl(llm.baseUrl),
      timeout: ONESHOT_TIMEOUT_MS,
      maxRetries: ONESHOT_MAX_RETRIES,
    })
    const msg = await withDeadline(
      client.messages.create({
        model: llm.model,
        max_tokens: maxOut,
        system: opts.system,
        messages: [{ role: 'user', content: opts.user }],
      }),
      ONESHOT_TIMEOUT_MS,
      'Anthropic 摘要',
    )
    const parts: string[] = []
    for (const b of msg.content) {
      if (b.type === 'text') {
        parts.push(b.text)
      }
    }
    return parts.join('\n').trim()
  }

  if (llm.provider === 'openai' || llm.provider === 'minimax' || llm.provider === 'openrouter') {
    const client = new OpenAI({
      apiKey: llm.apiKey,
      baseURL: normalizeBaseUrl(llm.baseUrl),
      timeout: ONESHOT_TIMEOUT_MS,
      maxRetries: ONESHOT_MAX_RETRIES,
    })
    const res = await withDeadline(
      client.chat.completions.create({
        model: llm.model,
        max_tokens: maxOut,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
      }),
      ONESHOT_TIMEOUT_MS,
      'OpenAI 摘要',
    )
    const t = res.choices[0]?.message?.content
    return typeof t === 'string' ? t.trim() : ''
  }

  if (llm.provider === 'gemini') {
    const genAI = new GoogleGenerativeAI(llm.apiKey)
    const model = genAI.getGenerativeModel({
      model: llm.model,
      systemInstruction: opts.system,
    })
    const result = await withDeadline(
      model.generateContent(opts.user),
      ONESHOT_TIMEOUT_MS,
      'Gemini 摘要',
    )
    return result.response.text().trim()
  }

  const _: never = llm.provider
  throw new Error(`未知 provider: ${String(_)}`)
}
