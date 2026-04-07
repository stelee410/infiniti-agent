import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { GoogleGenerativeAI } from '@google/generative-ai'
import type { InfinitiConfig } from '../config/types.js'

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
}

/** 无工具、无流式的单次补全（用于会话压缩摘要） */
export async function oneShotTextCompletion(
  opts: OneShotParams,
): Promise<string> {
  const maxOut = Math.min(8192, Math.max(256, opts.maxOutTokens ?? 4096))
  const { config } = opts

  if (config.llm.provider === 'anthropic') {
    const client = new Anthropic({
      apiKey: config.llm.apiKey,
      baseURL: normalizeBaseUrl(config.llm.baseUrl),
      timeout: ONESHOT_TIMEOUT_MS,
      maxRetries: ONESHOT_MAX_RETRIES,
    })
    const msg = await withDeadline(
      client.messages.create({
        model: config.llm.model,
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

  if (config.llm.provider === 'openai') {
    const client = new OpenAI({
      apiKey: config.llm.apiKey,
      baseURL: normalizeBaseUrl(config.llm.baseUrl),
      timeout: ONESHOT_TIMEOUT_MS,
      maxRetries: ONESHOT_MAX_RETRIES,
    })
    const res = await withDeadline(
      client.chat.completions.create({
        model: config.llm.model,
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

  if (config.llm.provider === 'gemini') {
    const genAI = new GoogleGenerativeAI(config.llm.apiKey)
    const model = genAI.getGenerativeModel({
      model: config.llm.model,
      systemInstruction: opts.system,
    })
    const result = await withDeadline(
      model.generateContent(opts.user),
      ONESHOT_TIMEOUT_MS,
      'Gemini 摘要',
    )
    return result.response.text().trim()
  }

  const _: never = config.llm.provider
  throw new Error(`未知 provider: ${String(_)}`)
}
