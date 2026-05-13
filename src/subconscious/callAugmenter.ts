import type { InfinitiConfig } from '../config/types.js'
import { oneShotTextCompletion } from '../llm/oneShotCompletion.js'
import { agentDebug } from '../utils/agentDebug.js'
import type { SubconsciousAgent } from './agent.js'

const AUGMENTER_TIMEOUT_MS = 25_000

const AUGMENTER_SYSTEM = `你是「电话通话」模式的后台补档 agent。主对话 LLM 刚和用户完成了一轮口语对话；它没有工具能力。

你要做的：判断这一轮回复**是否需要从长期记忆里捞东西**来让下一轮回复更准。

输出严格 JSON，单行，结构：
{"shouldRecall": boolean, "queries": string[]}

- shouldRecall=true 当且仅当用户问到了：
  - 涉及他/她自己的偏好、约定、过去事件、人际关系；
  - 引用了之前讨论过的某个项目/概念；
  - 你这一轮的回复显得含糊或缺少具体细节。
- queries 是 0~3 条**简短的中文检索短语**（不是问句，是关键词组合，例如「豚豚 北京工作 离职话术」）。
- 若 shouldRecall=false，queries 必须为 []。
- 不要包含解释、注释、markdown。仅输出 JSON。`

function tryParseJson(raw: string): { shouldRecall: boolean; queries: string[] } | null {
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const parsed = JSON.parse(m[0]) as { shouldRecall?: unknown; queries?: unknown }
    const shouldRecall = parsed.shouldRecall === true
    const queries = Array.isArray(parsed.queries)
      ? parsed.queries.filter((q): q is string => typeof q === 'string' && q.trim().length > 0).slice(0, 3)
      : []
    return { shouldRecall, queries }
  } catch {
    return null
  }
}

export type CallAugmenterOptions = {
  config: InfinitiConfig
  subconscious?: SubconsciousAgent
  signal?: AbortSignal
  /** LLM profile 名；不传则按 config.llm.callAugmenterProfile → subconsciousProfile → default 顺序 fallback。 */
  profile?: string
}

export class CallAugmenter {
  private inFlight: AbortController | null = null

  constructor(private readonly opts: CallAugmenterOptions) {}

  cancel(): void {
    if (this.inFlight) {
      this.inFlight.abort()
      this.inFlight = null
    }
  }

  /**
   * 异步评估一轮对话是否需要 memory recall。命中则去召回，把召回片段拼成一句
   * 摘要返回（供下一轮主 LLM 的 system 注入）。
   * 不抛错；任何步骤失败都返回 null。
   * 如果在评估期间被 cancel() 或外部 signal abort，提前返回 null。
   */
  async augment(userText: string, assistantText: string): Promise<string | null> {
    this.cancel()
    const controller = new AbortController()
    this.inFlight = controller
    const onParentAbort = () => controller.abort()
    if (this.opts.signal) {
      if (this.opts.signal.aborted) return null
      this.opts.signal.addEventListener('abort', onParentAbort, { once: true })
    }
    try {
      const profile = this.opts.profile
        ?? this.opts.config.llm.callAugmenterProfile
        ?? this.opts.config.llm.subconsciousProfile
      const judgment = await Promise.race([
        oneShotTextCompletion({
          config: this.opts.config,
          system: AUGMENTER_SYSTEM,
          user: `用户：${userText}\n助手：${assistantText}\n请输出 JSON。`,
          maxOutTokens: 256,
          ...(profile ? { profile } : {}),
        }),
        new Promise<string>((_resolve, reject) => {
          const t = setTimeout(() => reject(new Error('augmenter judgment timeout')), AUGMENTER_TIMEOUT_MS)
          controller.signal.addEventListener('abort', () => {
            clearTimeout(t)
            reject(new Error('augmenter aborted'))
          })
        }),
      ]).catch((e) => {
        agentDebug('[callAugmenter] judgment failed', (e as Error).message)
        return null
      })
      if (controller.signal.aborted) return null
      if (typeof judgment !== 'string') return null
      const parsed = tryParseJson(judgment)
      if (!parsed || !parsed.shouldRecall || parsed.queries.length === 0) return null

      if (!this.opts.subconscious) return null
      const snippets: string[] = []
      for (const q of parsed.queries) {
        if (controller.signal.aborted) return null
        try {
          const snippet = await this.opts.subconscious.retrieveRelevantMemory(q)
          if (snippet?.trim()) snippets.push(`关于「${q}」：${snippet.trim()}`)
        } catch (e) {
          agentDebug('[callAugmenter] recall failed', q, (e as Error).message)
        }
      }
      if (controller.signal.aborted || snippets.length === 0) return null
      return snippets.join('\n')
    } finally {
      if (this.opts.signal) {
        this.opts.signal.removeEventListener('abort', onParentAbort)
      }
      if (this.inFlight === controller) {
        this.inFlight = null
      }
    }
  }
}
